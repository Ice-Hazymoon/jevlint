/* eslint-disable no-console -- a reporter's job is printing */
import type { ClientStats } from './client.js';
import type { JevRuleStatus, JevSeverity } from './types.js';

/** One judged construct in a scan result. Lines are 1-based and inclusive. */
export interface ReportedVerdict {
    file: string;
    startLine: number;
    endLine: number;
    rule: string;
    source?: string;
    severity: JevSeverity;
    status: JevRuleStatus;
    why: string;
    /** Model probability that the code violates the rule. */
    probability: number;
    fix: string;
    confirm?: string;
    /** On an exempted entry: the exemption that applied, and every exemption's probability. */
    exemptedBy?: string;
    exemptions?: Record<string, number>;
}

/** Everything one scan produced. `hits` is what should be acted on. */
export interface LintRunResult {
    /** Model label answers were requested (or replayed) under. */
    model: string;
    provider: string;
    /** Verdicts at or above the rule's threshold, not exempted, not baselined, not suppressed inline. */
    hits: readonly ReportedVerdict[];
    /** With `review: true`: verdicts between 0.5 and the threshold. */
    review: readonly ReportedVerdict[];
    /** Verdicts that fired but a rule exemption applied. */
    exempted: readonly ReportedVerdict[];
    baselinedCount: number;
    suppressedInlineCount: number;
    /** Files whose whole-file rules were not judged because the file is too large. */
    skippedWholeFile: readonly string[];
    /** Files whose verdicts came from the cache because neither they nor the rules changed. */
    replayedFiles: number;
    filesScanned: number;
    chunkCount: number;
    stats: ClientStats;
}

/** Receives the result of every scan. Add reporters in the config's `reporters` array. */
export interface JevcheckReporter {
    name: string;
    onRunComplete: (result: LintRunResult) => void | Promise<void>;
}

function colorEnabled(): boolean {
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') { return false; }
    if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') { return true; }
    return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
}

/** ANSI styling that turns itself off for pipes, CI logs and `NO_COLOR`. */
export function createStyle(enabled: boolean = colorEnabled()): Record<'bold' | 'dim' | 'red' | 'yellow' | 'green' | 'cyan' | 'underline', (text: string) => string> {
    const wrap = (open: number, close: number) => (text: string): string => (enabled ? `\u001B[${open}m${text}\u001B[${close}m` : text);
    return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), yellow: wrap(33, 39), green: wrap(32, 39), cyan: wrap(36, 39), underline: wrap(4, 24) };
}

type Style = ReturnType<typeof createStyle>;
interface Entry { verdict: ReportedVerdict; label: string }

function entriesByFile(result: LintRunResult, style: Style, showExempted: boolean): Map<string, Entry[]> {
    const byFile = new Map<string, Entry[]>();
    const add = (verdict: ReportedVerdict, label: string, paint: (text: string) => string): void => {
        byFile.set(verdict.file, [...(byFile.get(verdict.file) ?? []), { verdict, label: paint(label.padEnd(7)) }]);
    };
    for (const hit of result.hits) { add(hit, hit.severity, hit.severity === 'error' ? style.red : style.yellow); }
    for (const item of result.review) { add(item, 'review', style.cyan); }
    for (const item of showExempted ? result.exempted : []) { add(item, 'exempt', style.dim); }
    return byFile;
}

function formatEntry({ verdict: v, label }: Entry, style: Style): string[] {
    const range = v.startLine === v.endLine ? `${v.startLine}` : `${v.startLine}-${v.endLine}`;
    const head = `  ${style.dim(range.padEnd(9))} ${label}  ${style.bold(v.rule)}  ${style.dim(`p=${v.probability.toFixed(2)}`)}`;
    const field = (name: string, text: string | undefined): string[] => (text ? [`             ${style.dim(name)}  ${text}`] : []);
    if (v.exemptedBy) { return [head, ...field('exempted by', v.exemptedBy)]; }
    return [head, ...field('why', v.why), ...field('fix', v.fix), ...field('confirm', v.confirm), ...field('source', v.source)];
}

function summary(result: LintRunResult, style: Style): string[] {
    const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
    const errors = result.hits.filter(hit => hit.severity === 'error').length;
    const warnings = result.hits.length - errors;
    const paint = errors > 0 ? style.red : style.yellow;
    const headline = result.hits.length === 0 ? style.green('✔ no hits') : paint(`✖ ${plural(result.hits.length, 'hit')} (${plural(errors, 'error')}, ${plural(warnings, 'warning')})`);
    const counts: Array<[number, string]> = [[result.exempted.length, 'exempted'], [result.baselinedCount, 'in baseline'], [result.suppressedInlineCount, 'suppressed inline'], [result.review.length, 'to review']];
    const extra = counts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
    const { requests, inputTokens, cacheHits, throttled } = result.stats;
    // Two separate stores: a whole file is replayed from the ledger when neither it nor the rules changed;
    // otherwise each question not covered by that is answered from the per-question cache or asked live.
    return [
        `${headline}${extra.length > 0 ? style.dim(` · ${extra.join(' · ')}`) : ''}`,
        style.dim(`${plural(result.filesScanned, 'file')} scanned · ${result.model} via ${result.provider} · ${plural(result.replayedFiles, 'file')} replayed from ledger, ${plural(cacheHits, 'answer')} from cache, ${plural(requests, 'request')}, ${inputTokens} input tokens${throttled > 0 ? `, ${throttled} rate-limited retries` : ''}`),
    ];
}

/** The stylish report as text: hits grouped by file, then a summary. `showExempted` also lists exempted verdicts. */
export function formatStylish(result: LintRunResult, options: { showExempted?: boolean; color?: boolean } = {}): string {
    const style = createStyle(options.color);
    const byFile = entriesByFile(result, style, Boolean(options.showExempted));
    const lines: string[] = [];
    for (const file of [...byFile.keys()].sort()) {
        const entries = byFile.get(file)!.sort((a, b) => a.verdict.startLine - b.verdict.startLine);
        lines.push(style.underline(file), ...entries.flatMap(entry => formatEntry(entry, style)), '');
    }
    const skipped = result.skippedWholeFile.map(file => `${style.yellow('skipped')} ${file}: too large for whole-file rules, they were not judged`);
    if (skipped.length > 0) { lines.push(...skipped, ''); }
    return [...lines, ...summary(result, style)].join('\n');
}

/** Human-readable report on stdout (the CLI default). */
export const stylishReporter: JevcheckReporter = {
    name: 'stylish',
    onRunComplete(result) {
        console.log(formatStylish(result));
    },
};

/** The whole `LintRunResult` as one JSON document on stdout. */
export const jsonReporter: JevcheckReporter = {
    name: 'json',
    onRunComplete(result) {
        console.log(JSON.stringify(result, null, 2));
    },
};
