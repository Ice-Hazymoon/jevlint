import type { CandidateMaps } from './candidates.js';
import type { JevClient } from './client.js';
import type { StoredFileResult } from './ledger.js';
import type { Chunk, JevRule, JevVerdict, NoulQuestion } from './types.js';
/**
 * The judging core: chunk/candidate selection, the violation + exemption
 * questions, the localization pass, and the ledger replay that makes an
 * unchanged file free to re-scan. Shared by `lint`, `test` and `recall`.
 */
import { buildCandidateText, matchesGlobs } from './candidates.js';
import { chunkFile, locateWindows } from './chunk.js';
import { estimateTokens } from './client.js';
import { fileKey, readFileResult, writeFileResult } from './ledger.js';

export const DEFAULT_THRESHOLD = 0.8;
export const REVIEW_FLOOR = 0.5;
export const LOCATE_FLOOR = 0.6;
export const EXEMPT_FLOOR = 0.5;
// state + longest question must stay under 32k; whole-file rules on larger files are reported as skipped, never silently passed.
export const WHOLE_FILE_TOKEN_LIMIT = 24_000;
export const RECALL_BAR = 0.9;
export const RECALL_MIN_SAMPLE = 5;

function toQuestion(rule: JevRule): NoulQuestion {
    return { type: 'noul', instructions: rule.question, criteria: rule.criteria };
}

export function applicable(rule: JevRule, chunk: Chunk, noPrefilter: boolean): boolean {
    return matchesGlobs(rule.files, chunk.file) && !matchesGlobs(rule.exclude, chunk.file) && (noPrefilter || ((!rule.prefilter || rule.prefilter.test(chunk.text)) && !rule.unless?.test(chunk.text)));
}

export function exemptedBy(verdict: JevVerdict): string | undefined {
    return Object.entries(verdict.exemptions).find(([, probability]) => probability >= EXEMPT_FLOOR)?.[0];
}

/** Selects rules by id / id-prefix (`<group>/`) and, optionally, `owned` status only. */
export function selectRules(rules: readonly JevRule[], opts: { ids?: readonly string[]; owned?: boolean } = {}): readonly JevRule[] {
    let selected = rules;
    if (opts.ids && opts.ids.length > 0) {
        const unknown = opts.ids.filter(id => !rules.some(rule => rule.id === id || rule.id.startsWith(`${id}/`)));
        if (unknown.length > 0) { throw new Error(`Unknown rule id(s): ${unknown.join(', ')}`); }
        selected = selected.filter(rule => opts.ids!.some(id => rule.id === id || rule.id.startsWith(`${id}/`)));
    }
    if (opts.owned) { selected = selected.filter(rule => rule.status === 'owned'); }
    return selected;
}

/** The violation question plus one question per exemption, keyed `<rule id>` and `<rule id>#<exemption id>`. */
function questionsFor(rules: readonly JevRule[]): Record<string, NoulQuestion> {
    const questions: Record<string, NoulQuestion> = {};
    for (const rule of rules) {
        questions[rule.id] = toQuestion(rule);
        for (const exemption of rule.exemptions ?? []) { questions[`${rule.id}#${exemption.id}`] = { type: 'noul', instructions: exemption.question, criteria: exemption.criteria }; }
    }
    return questions;
}

/** Rules with a `prepare` see their own edited state; all others share the raw chunk in one request. */
function groupByPrepare(rules: readonly JevRule[]): Map<JevRule['prepare'], JevRule[]> {
    const groups = new Map<JevRule['prepare'], JevRule[]>();
    for (const rule of rules) { groups.set(rule.prepare, [...(groups.get(rule.prepare) ?? []), rule]); }
    return groups;
}

async function judgeGroup(client: JevClient, chunk: Chunk, prepare: JevRule['prepare'], group: readonly JevRule[], noPrefilter: boolean): Promise<JevVerdict[]> {
    const prepared = prepare ? prepare(chunk.text) : chunk.text;
    // `prepare` can remove the very construct the prefilter saw: the gate is re-tested on what gets sent.
    const asked = prepare ? group.filter(rule => noPrefilter || !rule.prefilter || rule.prefilter.test(prepared)) : group;
    if (asked.length === 0) { return []; }
    const answers = await client.ask({ file: chunk.file, code: prepared }, questionsFor(asked));
    return asked.map((rule): JevVerdict => ({
        rule,
        chunk,
        probability: answers[rule.id] ?? 0,
        exemptions: Object.fromEntries((rule.exemptions ?? []).map(exemption => [exemption.id, answers[`${rule.id}#${exemption.id}`] ?? 0])),
    }));
}

export async function judgeChunk(client: JevClient, chunk: Chunk, selected: readonly JevRule[], noPrefilter: boolean): Promise<JevVerdict[]> {
    const active = selected.filter(rule => applicable(rule, chunk, noPrefilter));
    if (active.length === 0) { return []; }
    const verdicts = await Promise.all([...groupByPrepare(active)].map(([prepare, group]) => judgeGroup(client, chunk, prepare, group, noPrefilter)));
    return verdicts.flat();
}

/**
 * Second pass over small windows of a fired chunk. It narrows the hit to a
 * line range, and it un-masks: a chunk-level exemption can be true for one
 * construct while its neighbour violates, so an exempted chunk becomes a hit
 * again when some window fires with no exemption of its own.
 */
export async function locate(client: JevClient, verdict: JevVerdict, fileLines: readonly string[], noPrefilter: boolean): Promise<void> {
    if (verdict.rule.wholeFile) { return; }
    const exemptionId = exemptedBy(verdict);
    if (exemptionId && verdict.rule.exemptions?.find(exemption => exemption.id === exemptionId)?.scope === 'chunk') { return; }
    const windows = locateWindows(fileLines, verdict.chunk);
    if (windows.length < 2) { return; }
    const importLines = fileLines.findLastIndex(line => /^import\s/.test(line)) + 1;
    const header = importLines > 0 && windows[0] && windows[0].startLine > importLines ? `${fileLines.slice(0, Math.min(importLines, 60)).join('\n')}\n// …\n` : '';
    const threshold = verdict.rule.threshold ?? DEFAULT_THRESHOLD;
    const scored = (await Promise.all(windows.map(async (window) => {
        const chunk: Chunk = { file: verdict.chunk.file, startLine: window.startLine, endLine: window.endLine, text: header + window.text };
        return (await judgeChunk(client, chunk, [verdict.rule], noPrefilter))[0];
    }))).filter((item): item is JevVerdict => item !== undefined);
    const unexempted = scored.filter(item => !exemptedBy(item));
    const best = (exemptedBy(verdict) ? unexempted.filter(item => item.probability >= threshold) : unexempted)
        .reduce<JevVerdict | undefined>((a, b) => (!a || b.probability > a.probability ? b : a), undefined);
    if (!best || best.probability < LOCATE_FLOOR) { return; }
    verdict.located = { startLine: best.chunk.startLine, endLine: best.chunk.endLine, probability: best.probability };
    if (exemptedBy(verdict)) { verdict.exemptions = {}; }
}

export interface FileResult { verdicts: JevVerdict[]; chunks: number; skippedWholeFile: boolean; replayed: boolean }

export interface JudgeFileOptions {
    client: JevClient;
    model: string;
    cacheDir: string;
    useLedger: boolean;
    noLocate: boolean;
    noPrefilter: boolean;
    candidateMaps: CandidateMaps;
}

function replayFromLedger(file: string, rules: readonly JevRule[], stored: StoredFileResult): FileResult {
    const byId = new Map(rules.map(rule => [rule.id, rule]));
    const verdicts = stored.verdicts.flatMap((item): JevVerdict[] => {
        const rule = byId.get(item.rule);
        return rule ? [{ rule, chunk: { file, startLine: item.startLine, endLine: item.endLine, text: '' }, probability: item.probability, exemptions: item.exemptions, located: item.located }] : [];
    });
    return { verdicts, chunks: 0, skippedWholeFile: stored.skippedWholeFile, replayed: true };
}

/** One request per ast-grep match of each candidate rule: the construct (± context), after the file's import header when it starts below it. */
function candidateJobs(file: string, lines: readonly string[], rules: readonly JevRule[], options: JudgeFileOptions): Array<Promise<JevVerdict[]>> {
    const importLines = lines.findLastIndex(line => /^import\s/.test(line)) + 1;
    return rules.filter(rule => rule.candidates).flatMap(rule => (options.candidateMaps.candidates.get(rule)?.get(file) ?? []).map((candidate) => {
        const { contextBefore = 0, contextAfter = 0, related } = rule.candidates!;
        const header = importLines > 0 && candidate.startLine - contextBefore > importLines ? `${lines.slice(0, Math.min(importLines, 60)).join('\n')}\n// …\n` : '';
        const built = buildCandidateText(lines, header, candidate, contextBefore, contextAfter, related && { config: related, matches: options.candidateMaps.related.get(rule)?.get(file) ?? [] });
        return judgeChunk(options.client, { file, startLine: built.startLine, endLine: built.endLine, text: built.text }, [rule], options.noPrefilter);
    }));
}

/** Everything a file's judgment produces, replayed from the ledger when the file and rules are unchanged. */
export async function judgeFile(file: string, text: string, selected: readonly JevRule[], options: JudgeFileOptions): Promise<FileResult> {
    const { client, cacheDir, useLedger, noPrefilter } = options;
    const inScope = selected.filter(rule => matchesGlobs(rule.files, file) && !matchesGlobs(rule.exclude, file) && (!rule.filePrefilter || rule.filePrefilter.test(text)));
    if (inScope.length === 0) { return { verdicts: [], chunks: 0, skippedWholeFile: false, replayed: false }; }
    const key = fileKey(options.model, file, text, inScope, !options.noLocate);
    const stored = useLedger ? readFileResult(cacheDir, key) : null;
    if (stored) { return replayFromLedger(file, inScope, stored); }
    const lines = text.split('\n');
    const chunkRules = inScope.filter(rule => !rule.wholeFile && !rule.candidates);
    const fileRules = inScope.filter(rule => rule.wholeFile);
    const chunks = chunkFile(file, text);
    const whole: Chunk = { file, startLine: 1, endLine: lines.length, text };
    const skippedWholeFile = estimateTokens(text) > WHOLE_FILE_TOKEN_LIMIT && fileRules.some(rule => applicable(rule, whole, noPrefilter));
    const jobs = candidateJobs(file, lines, inScope, options);
    const verdicts = (await Promise.all([
        ...chunks.map(chunk => judgeChunk(client, chunk, chunkRules, noPrefilter)),
        ...(skippedWholeFile ? [] : [judgeChunk(client, whole, fileRules, noPrefilter)]),
        ...jobs,
    ])).flat();
    if (!options.noLocate) {
        // Candidate verdicts are already construct-sized: nothing to narrow, nothing to un-mask.
        const fired = verdicts.filter(v => !v.rule.candidates && v.probability >= (v.rule.threshold ?? DEFAULT_THRESHOLD));
        await Promise.all(fired.map(item => locate(client, item, lines, noPrefilter)));
    }
    if (useLedger) {
        writeFileResult(cacheDir, key, {
            skippedWholeFile,
            verdicts: verdicts.map(v => ({ rule: v.rule.id, startLine: v.chunk.startLine, endLine: v.chunk.endLine, probability: v.probability, exemptions: v.exemptions, located: v.located })),
        });
    }
    return { verdicts, chunks: chunks.length + jobs.length, skippedWholeFile, replayed: false };
}
