import type { RecallMutantResult, RecallOptions, RecallResult, TestCaseResult, TestOptions, TestResult } from './api.js';
import type { JevClient } from './client.js';
import type { ResolvedJevlintConfig } from './config.js';
import type { Chunk, JevMutant, JevRule, JevVerdict } from './types.js';
/**
 * Rule quality checks: fixtures (`test`) prove a question can work; mutation recall (`recall`) proves it
 * catches the mistake in real code.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeCalibration } from './calibration.js';
import { candidateMapsForText, matchesGlobs } from './candidates.js';
import { estimateTokens } from './client.js';
import { applicable, DEFAULT_THRESHOLD, exemptedBy, judgeChunk, judgeFile, RECALL_BAR, RECALL_MIN_SAMPLE, REVIEW_FLOOR, selectRules, WHOLE_FILE_TOKEN_LIMIT } from './engine.js';

type FixtureKind = 'invalid' | 'valid' | 'exempt';

/** Judges text that is not on disk under its path (a fixture or a mutant) exactly as a scan would judge that file. */
async function judgeText(client: JevClient, cacheDir: string, rule: JevRule, file: string, text: string): Promise<JevVerdict[]> {
    const options = { client, model: client.provider.model, cacheDir, useLedger: false, noLocate: false, noPrefilter: false, candidateMaps: candidateMapsForText(rule, file, text) };
    return (await judgeFile(file, text, [rule], options)).verdicts;
}

function strongest(verdicts: readonly JevVerdict[]): JevVerdict | undefined {
    return verdicts.reduce<JevVerdict | undefined>((best, item) => (!best || item.probability > best.probability ? item : best), undefined);
}

function readFixture(rule: JevRule, dir: string, name: string): Chunk {
    const raw = readFileSync(join(dir, name), 'utf-8');
    const header = /^\/\/ path: (\S+)\n/.exec(raw);
    if (!header?.[1]) { throw new Error(`${rule.id}/${name}: first line must be "// path: <repo-relative path>"`); }
    return { file: header[1], startLine: 1, endLine: 0, text: raw.slice(header[0].length) };
}

function fixtureKind(name: string): FixtureKind {
    return name.startsWith('invalid-') ? 'invalid' : name.startsWith('exempt-') ? 'exempt' : 'valid';
}

/** invalid: fires with no exemption. exempt: an exemption applies. valid: stays under the review floor. */
function scoreFixture(key: string, kind: FixtureKind, threshold: number, verdict: JevVerdict | undefined): TestCaseResult {
    const probability = verdict?.probability ?? 0;
    const exemption = verdict ? exemptedBy(verdict) : undefined;
    const ok = kind === 'invalid' ? probability >= threshold && !exemption : kind === 'exempt' ? exemption !== undefined : probability < REVIEW_FLOOR;
    const exemptions = verdict ? Object.entries(verdict.exemptions) : [];
    const detail = `p=${probability.toFixed(3)}${exemptions.length > 0 ? `  ${exemptions.map(([id, p]) => `${id}=${p.toFixed(2)}`).join(' ')}` : ''}`;
    const margin = kind === 'invalid' ? probability - threshold : REVIEW_FLOOR - probability;
    return { key, ok, detail, probability, thinMargin: ok && kind !== 'exempt' && margin < 0.05 };
}

async function judgeFixture(client: JevClient, cacheDir: string, rule: JevRule, key: string, chunk: Chunk, kind: FixtureKind): Promise<TestCaseResult> {
    // A candidate rule's fixture runs through judgeFile like a real file; any other rule is asked about the fixture as one chunk.
    const verdicts = rule.candidates ? await judgeText(client, cacheDir, rule, chunk.file, chunk.text) : await judgeChunk(client, chunk, [rule], false);
    return scoreFixture(key, kind, rule.threshold ?? DEFAULT_THRESHOLD, strongest(verdicts));
}

function recordOrCompare(config: ResolvedJevlintConfig, client: JevClient, cases: readonly TestCaseResult[], opts: TestOptions): Pick<TestResult, 'drift' | 'recorded'> {
    const answered = cases.filter((c): c is TestCaseResult & { probability: number } => c.probability !== undefined);
    if (opts.record) {
        const merged = mergeCalibration(config.calibration, client.provider.model, client.provider.name, Object.fromEntries(answered.map(c => [c.key, Number(c.probability.toFixed(3))])));
        writeFileSync(config.calibration, `${JSON.stringify(merged, null, 1)}\n`);
        return { recorded: { fixtureAnswers: answered.length, totalAnswers: Object.keys(merged.answers).length } };
    }
    if (!opts.drift || !existsSync(config.calibration)) { return {}; }
    const recorded = (JSON.parse(readFileSync(config.calibration, 'utf-8')) as { answers: Record<string, number> }).answers;
    const moved = answered.map(c => ({ key: c.key, before: recorded[c.key], after: c.probability })).filter((item): item is { key: string; before: number; after: number } => item.before !== undefined);
    const delta = (item: { before: number; after: number }): number => Math.abs(item.after - item.before);
    const meanAbsoluteDelta = moved.reduce((sum, item) => sum + delta(item), 0) / Math.max(1, moved.length);
    return { drift: { meanAbsoluteDelta, moved: moved.filter(item => delta(item) >= 0.1).sort((x, y) => delta(y) - delta(x)) } };
}

/** Runs every selected rule against `<fixtures>/<rule id, "/" as "__">/{invalid,valid,exempt}-*`. */
export async function runFixtures(config: ResolvedJevlintConfig, client: JevClient, opts: TestOptions): Promise<TestResult> {
    const missing: string[] = [];
    let neverAsked = 0;
    const tasks: Array<Promise<TestCaseResult>> = [];
    for (const rule of selectRules(config.rules, { ids: opts.rules })) {
        const dir = join(config.fixtures, rule.id.replaceAll('/', '__'));
        const names = existsSync(dir) ? readdirSync(dir).filter(name => /^(?:invalid|valid|exempt)-/.test(name)).sort() : [];
        if (!names.some(name => name.startsWith('invalid-')) || !names.some(name => name.startsWith('valid-'))) { missing.push(rule.id); }
        for (const name of names) {
            const chunk = readFixture(rule, dir, name);
            const kind = fixtureKind(name);
            const key = `${rule.id}/${name}`;
            if (applicable(rule, chunk, false)) {
                tasks.push(judgeFixture(client, config.cacheDir, rule, key, chunk, kind));
                continue;
            }
            // Stopped by scope or prefilter: fine for a valid fixture, a catalog bug for an invalid one.
            neverAsked += kind === 'invalid' ? 0 : 1;
            tasks.push(Promise.resolve({ key, ok: kind !== 'invalid', detail: 'not asked (scope/prefilter)' }));
        }
    }
    const cases = await Promise.all(tasks);
    return {
        cases,
        failures: cases.filter(c => !c.ok).length,
        missingFixtures: missing,
        neverAsked,
        thin: cases.filter(c => c.thinMargin),
        ...recordOrCompare(config, client, cases, opts),
        requests: client.stats.requests,
        inputTokens: client.stats.inputTokens,
    };
}

/** Up to `limit` real files the mutant changes, in a stable pseudo-random order per rule (so samples spread across directories). */
function mutableFiles(config: ResolvedJevlintConfig, rule: JevRule, mutant: JevMutant, files: readonly string[], limit: number): Array<{ file: string; text: string }> {
    const order = (file: string): string => createHash('sha1').update(rule.id).update(file).digest('hex');
    const tokenLimit = rule.wholeFile ? WHOLE_FILE_TOKEN_LIMIT : WHOLE_FILE_TOKEN_LIMIT * 2;
    const found: Array<{ file: string; text: string }> = [];
    for (const file of [...files].sort((a, b) => order(a).localeCompare(order(b)))) {
        if (found.length >= limit) { break; }
        if (!matchesGlobs(rule.files, file) || matchesGlobs(rule.exclude, file)) { continue; }
        const original = readFileSync(join(config.root, file), 'utf-8');
        const mutated = estimateTokens(original) > tokenLimit ? null : mutant.apply(original);
        if (mutated && mutated !== original) { found.push({ file, text: mutated }); }
    }
    return found;
}

/** caught: fires unexempted. invalid: an exemption legitimately claims the mutant, so it says nothing about recall. */
async function judgeMutant(client: JevClient, cacheDir: string, rule: JevRule, file: string, text: string): Promise<{ outcome: 'caught' | 'invalid' | 'missed'; note: string }> {
    const threshold = rule.threshold ?? DEFAULT_THRESHOLD;
    const verdicts = await judgeText(client, cacheDir, rule, file, text);
    const best = Math.max(0, ...verdicts.filter(v => !exemptedBy(v)).map(v => v.probability));
    if (best >= threshold) { return { outcome: 'caught', note: file }; }
    const exemptedFire = verdicts.find(v => v.probability >= threshold && exemptedBy(v)) ?? (verdicts.length > 0 && verdicts.every(v => exemptedBy(v)) ? verdicts[0] : undefined);
    if (exemptedFire) { return { outcome: 'invalid', note: `${file} (exempted by ${exemptedBy(exemptedFire)})` }; }
    return { outcome: 'missed', note: `${file} (${verdicts.length === 0 ? 'not asked: prefilter / no candidate' : `p=${best.toFixed(2)}`})` };
}

async function measureMutant(config: ResolvedJevlintConfig, client: JevClient, rule: JevRule, mutant: JevMutant, opts: RecallOptions): Promise<RecallMutantResult> {
    const sampleSize = opts.sampleSize ?? 12;
    const candidates = mutableFiles(config, rule, mutant, opts.files, sampleSize * 3);
    const sample = candidates.slice(0, sampleSize);
    const base = { rule: rule.id, mutant: mutant.id, candidateCount: candidates.length };
    if (opts.dry) { return { ...base, caught: 0, judged: 0, misses: sample.map(item => item.file), invalidMutants: [] }; }
    const outcomes = await Promise.all(sample.map(({ file, text }) => judgeMutant(client, config.cacheDir, rule, file, text)));
    const notes = (outcome: string): string[] => outcomes.filter(item => item.outcome === outcome).map(item => item.note);
    const caught = notes('caught').length;
    const invalidMutants = notes('invalid');
    const judged = sample.length - invalidMutants.length;
    if (judged === 0) { return { ...base, caught, judged, misses: notes('missed'), invalidMutants }; }
    const recall = caught / judged;
    // A sample that covers every mutable file is the whole population, however small.
    const graduates = recall >= RECALL_BAR && (judged >= RECALL_MIN_SAMPLE || candidates.length <= sampleSize);
    return { ...base, caught, judged, recall, graduates, misses: notes('missed'), invalidMutants };
}

/** Injects each selected rule's mutants into real files and measures the share of violations caught. */
export async function runRecall(config: ResolvedJevlintConfig, client: JevClient, opts: RecallOptions): Promise<RecallResult> {
    const tracked = opts.files.filter(file => matchesGlobs(config.include, file) && !matchesGlobs(config.ignore, file));
    const mutants: RecallMutantResult[] = [];
    for (const rule of selectRules(config.rules, { ids: opts.rules })) {
        for (const mutant of rule.mutants ?? []) { mutants.push(await measureMutant(config, client, rule, mutant, { ...opts, files: tracked })); }
    }
    const weakestRecall = Math.min(1, ...mutants.flatMap(m => (m.recall === undefined ? [] : [m.recall])));
    return { mutants, weakestRecall, requests: client.stats.requests, inputTokens: client.stats.inputTokens };
}
