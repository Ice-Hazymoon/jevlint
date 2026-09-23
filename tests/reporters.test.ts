import type { LintRunResult, ReportedVerdict } from '../src/reporters.js';
import { describe, expect, it } from 'vitest';
import { formatStylish } from '../src/reporters.js';

function verdict(file: string, startLine: number, extra: Partial<ReportedVerdict> = {}): ReportedVerdict {
    return {
        file,
        startLine,
        endLine: startLine + 2,
        rule: 'logging/no-secret-in-log',
        severity: 'error',
        status: 'owned',
        why: 'Secrets in logs are hard to purge.',
        probability: 0.934,
        fix: 'Log a redacted value.',
        ...extra,
    };
}

function result(overrides: Partial<LintRunResult> = {}): LintRunResult {
    return {
        model: 'model-a',
        provider: 'replay',
        hits: [],
        review: [],
        exempted: [],
        baselinedCount: 0,
        suppressedInlineCount: 0,
        skippedWholeFile: [],
        replayedFiles: 0,
        filesScanned: 3,
        chunkCount: 3,
        stats: { requests: 0, inputTokens: 0, cacheHits: 4, asked: 0, throttled: 0 },
        ...overrides,
    };
}

describe('formatStylish', () => {
    it('groups hits by file in line order and shows rule, probability, why, fix, confirm and source', () => {
        const text = formatStylish(result({
            hits: [verdict('src/b.ts', 30), verdict('src/a.ts', 9, { severity: 'warning', confirm: 'Check the caller.', source: 'Team logging policy' }), verdict('src/b.ts', 4)],
            exempted: [verdict('src/c.ts', 1, { exemptedBy: 'redacted' })],
            baselinedCount: 2,
        }), { color: false });
        const lines = text.split('\n');
        expect(lines[0]).toBe('src/a.ts');
        expect(lines[1]).toBe('  9-11      warning  logging/no-secret-in-log  p=0.93');
        expect(text).toContain('why  Secrets in logs are hard to purge.');
        expect(text).toContain('fix  Log a redacted value.');
        expect(text).toContain('confirm  Check the caller.');
        expect(text).toContain('source  Team logging policy');
        expect(text.indexOf('  4-6 ')).toBeLessThan(text.indexOf('  30-32 '));
        expect(text).not.toContain('src/c.ts');
        expect(text).toContain('✖ 3 hits (2 errors, 1 warning) · 1 exempted · 2 in baseline');
        expect(text).toContain('3 files scanned');
    });

    it('names the ledger and answer caches separately in the summary', () => {
        const text = formatStylish(result({ replayedFiles: 3, stats: { requests: 2, inputTokens: 480, cacheHits: 12, asked: 0, throttled: 0 } }), { color: false });
        expect(text).toContain('3 files replayed from ledger, 12 answers from cache, 2 requests, 480 input tokens');
    });

    it('lists exempted verdicts on request and reports a clean run', () => {
        const exempted = formatStylish(result({ exempted: [verdict('src/c.ts', 1, { exemptedBy: 'redacted' })] }), { color: false, showExempted: true });
        expect(exempted).toContain('exempt   logging/no-secret-in-log');
        expect(exempted).toContain('exempted by  redacted');
        expect(formatStylish(result(), { color: false })).toContain('✔ no hits');
    });

    it('emits ANSI styling only when color is on', () => {
        const hits = { hits: [verdict('src/a.ts', 1)] };
        expect(formatStylish(result(hits), { color: false })).not.toContain('\u001B[');
        expect(formatStylish(result(hits), { color: true })).toContain('\u001B[31merror  \u001B[39m');
    });
});
