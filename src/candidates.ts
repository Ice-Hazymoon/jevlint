import type { AstGrepLanguage, AstGrepMatch } from './astGrep.js';
import type { JevRelatedCandidates, JevRule } from './types.js';
/**
 * Select, then judge: ast-grep picks the exact constructs a `candidates` rule cares about, and this
 * module turns each matched node into the text Jev sees — the construct itself (± `contextBefore` /
 * `contextAfter` line windows) and, when the rule declares `related`, a second construct spliced in
 * as labelled context regardless of how far away it sits in the file.
 *
 * `related` exists for evidence a line-count window cannot reach: a query built in one helper and
 * consumed by a loop in its caller, or a sensitive call wrapped by a function whose own caller maps
 * it over a list, can be hundreds of lines apart in the same file. A second ast-grep rule selects
 * the far construct; `linkBy` names a metavariable both rules capture (ast-grep unifies
 * metavariables across `all:`/relational sub-rules, so one rule can capture an identifier from a
 * `follows`/`inside` constraint without that constraint being required for the match). Only related
 * matches whose captured text equals the candidate's are spliced in, nearest declared line first,
 * capped at `maxLines` total — a deterministic prefix of the sorted list, not a mid-block
 * truncation, so the same edit always produces the same chunk.
 */
import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { findAstMatches } from './astGrep.js';

const DEFAULT_RELATED_MAX_LINES = 60;

export interface LineSpan { startLine: number; endLine: number }
/** One ast-grep match, reduced to its line span and the single-capture metavariables it bound. */
export type Candidate = AstGrepMatch;

/** A nested match is already inside its outer match's text; judging both would report the same construct twice. */
export function outermost<T extends LineSpan>(all: readonly T[]): T[] {
    // Two `any:` branches can select the same node: equal spans collapse to one before nesting is resolved.
    const spans = [...new Map(all.map(span => [`${span.startLine}:${span.endLine}`, span])).values()];
    return spans.filter(span => !spans.some(other => other !== span && other.startLine <= span.startLine && other.endLine >= span.endLine && (other.startLine < span.startLine || other.endLine > span.endLine)));
}

/** A Vue SFC as TypeScript for the candidate stage: every line outside `<script>` is blanked, so line numbers stay true. */
function vueScriptAsTs(text: string): string {
    let inScript = false;
    return text.split('\n').map((line) => {
        if (!inScript) {
            if (/^<script\b/.test(line)) { inScript = true; }
            return '';
        }
        if (line.startsWith('</script>')) {
            inScript = false;
            return '';
        }
        return line;
    }).join('\n');
}

/** How a file is fed to ast-grep: TypeScript, TSX, the `<script>` of a Vue SFC, or not at all. */
function astGrepInput(file: string, text: string): { text: string; language: AstGrepLanguage } | undefined {
    if (/\.[cm]?ts$/.test(file)) { return { text, language: 'typescript' }; }
    if (file.endsWith('.tsx')) { return { text, language: 'tsx' }; }
    if (file.endsWith('.vue')) { return { text: vueScriptAsTs(text), language: 'typescript' }; }
    return undefined;
}

/** Outermost matches of one rule in one file's text; empty for a file type ast-grep does not read. */
export function matchText(ruleYaml: string, file: string, text: string): Candidate[] {
    const input = astGrepInput(file, text);
    return input ? outermost(findAstMatches(ruleYaml, input.text, input.language)) : [];
}

/** One rule over every file on disk in scope for it; returns 1-based line spans + captures per file. */
export function findMatches(root: string, ruleYaml: string, files: readonly string[]): Map<string, Candidate[]> {
    const spans = new Map<string, Candidate[]>();
    for (const file of files) {
        if (!astGrepInput(file, '')) { continue; }
        const found = matchText(ruleYaml, file, readFileSync(join(root, file), 'utf-8'));
        if (found.length > 0) { spans.set(file, found); }
    }
    return spans;
}

export function matchesGlobs(globs: readonly string[] | undefined, file: string): boolean {
    return (globs ?? []).some(glob => matchesGlob(file, glob));
}

function inScopeFiles(rule: JevRule, files: readonly string[]): string[] {
    return files.filter(file => matchesGlobs(rule.files, file) && !matchesGlobs(rule.exclude, file));
}

/** Every rule's candidate spans, plus its related rule's spans when it declares one, over a real file set. */
export interface CandidateMaps {
    candidates: ReadonlyMap<JevRule, ReadonlyMap<string, readonly Candidate[]>>;
    related: ReadonlyMap<JevRule, ReadonlyMap<string, readonly Candidate[]>>;
}

export function buildCandidateMaps(root: string, rules: readonly JevRule[], files: readonly string[]): CandidateMaps {
    const withCandidates = rules.filter((rule): rule is JevRule & { candidates: NonNullable<JevRule['candidates']> } => Boolean(rule.candidates));
    return {
        candidates: new Map(withCandidates.map(rule => [rule, findMatches(root, rule.candidates.rule, inScopeFiles(rule, files))] as const)),
        related: new Map(withCandidates.filter(rule => rule.candidates.related).map(rule => [rule, findMatches(root, rule.candidates.related!.rule, inScopeFiles(rule, files))] as const)),
    };
}

/** Candidates (and related matches) for text that is not on disk under its real path (fixtures, mutants). */
export function candidateMapsForText(rule: JevRule, file: string, text: string): CandidateMaps {
    if (!rule.candidates) { return { candidates: new Map(), related: new Map() }; }
    const related = rule.candidates.related;
    return {
        candidates: new Map([[rule, new Map([[file, matchText(rule.candidates.rule, file, text)]])]]),
        related: related ? new Map([[rule, new Map([[file, matchText(related.rule, file, text)]])]]) : new Map(),
    };
}

/**
 * Related matches linked to one candidate: equal `linkBy` capture (or every match, when `linkBy` is
 * omitted), minus the candidate's own span, nearest declared line first. Pure and offline-testable —
 * no ast-grep call — because linking is a property of the captured text, not of running the tool again.
 */
export function selectRelated(candidate: Candidate, related: readonly Candidate[], config: JevRelatedCandidates): Candidate[] {
    const linked = config.linkBy
        ? related.filter(item => candidate.meta[config.linkBy!] !== undefined && item.meta[config.linkBy!] === candidate.meta[config.linkBy!])
        : related;
    return [...linked]
        .filter(item => !(item.startLine === candidate.startLine && item.endLine === candidate.endLine))
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

/**
 * Appends related context to a candidate's own body text: each linked match (± its own
 * `contextBefore`/`contextAfter`), in line order, stopping — not truncating — once the next block
 * would push the total past `maxLines`. Returns `body` unchanged when there is nothing to append, so a
 * candidate with no linked related match produces byte-identical text to a rule with no `related` field.
 */
export function appendRelatedContext(lines: readonly string[], body: string, candidate: Candidate, related: readonly Candidate[], config: JevRelatedCandidates): string {
    const linked = selectRelated(candidate, related, config);
    const maxLines = config.maxLines ?? DEFAULT_RELATED_MAX_LINES;
    let used = 0;
    const blocks: string[] = [];
    for (const item of linked) {
        const start = Math.max(1, item.startLine - (config.contextBefore ?? 0));
        const end = Math.min(lines.length, item.endLine + (config.contextAfter ?? 0));
        const blockLines = lines.slice(start - 1, end);
        if (used + blockLines.length > maxLines) { break; }
        used += blockLines.length;
        blocks.push(blockLines.join('\n'));
    }
    if (blocks.length === 0) { return body; }
    return `${body}\n\n// --- ${config.label} ---\n${blocks.join('\n\n// ---\n')}`;
}

/** Builds the final text of one candidate job: header + the construct (± context) + any related context. */
export function buildCandidateText(lines: readonly string[], header: string, candidate: Candidate, contextBefore: number, contextAfter: number, related?: { config: JevRelatedCandidates; matches: readonly Candidate[] }): { startLine: number; endLine: number; text: string } {
    const startLine = Math.max(1, candidate.startLine - contextBefore);
    const endLine = Math.min(lines.length, candidate.endLine + contextAfter);
    const body = header + lines.slice(startLine - 1, endLine).join('\n');
    const text = related ? appendRelatedContext(lines, body, candidate, related.matches, related.config) : body;
    return { startLine, endLine, text };
}
