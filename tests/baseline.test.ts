import type { JevRule, JevVerdict } from '../src/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprint, inlineSuppressed, readBaseline, writeBaseline } from '../src/baseline.js';

const rule: JevRule = {
    id: 'demo/no-console-log',
    source: 'demo-rule DR1',
    severity: 'warning',
    status: 'owned',
    why: 'noise',
    files: ['**/*.ts'],
    question: 'q',
    criteria: { true: 't', false: 'f' },
    fix: 'remove it',
};

function verdictFor(lines: string[], startLine: number, endLine: number): JevVerdict {
    return { rule, chunk: { file: 'src/a.ts', startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') }, probability: 0.9, exemptions: {} };
}

describe('fingerprint', () => {
    it('is stable across edits outside the flagged range and changes when the flagged text changes', () => {
        const before = ['const a = 1;', 'console.log(a);', 'const b = 2;'];
        const after = ['const a = 1; // an added comment', 'console.log(a);', 'const b = 2;'];
        const changed = ['const a = 1;', 'console.log(a, "extra");', 'const b = 2;'];
        expect(fingerprint(verdictFor(before, 2, 2), before)).toBe(fingerprint(verdictFor(after, 2, 2), after));
        expect(fingerprint(verdictFor(before, 2, 2), before)).not.toBe(fingerprint(verdictFor(changed, 2, 2), changed));
    });

    it('is normalized against surrounding whitespace', () => {
        const a = ['  console.log(1);  '];
        const b = ['console.log(1);'];
        expect(fingerprint(verdictFor(a, 1, 1), a)).toBe(fingerprint(verdictFor(b, 1, 1), b));
    });
});

describe('inlineSuppressed', () => {
    it('matches by rule id or by the short code from `source`, with a reason', () => {
        const withId = ['// jevcheck-ignore demo/no-console-log -- intentional debug output', 'console.log(1);'];
        const withCode = ['// jevcheck-ignore DR1 -- intentional debug output', 'console.log(1);'];
        const noReason = ['// jevcheck-ignore demo/no-console-log', 'console.log(1);'];
        const noMarker = ['console.log(1);'];
        expect(inlineSuppressed(verdictFor(withId, 2, 2), withId)).toBe(true);
        expect(inlineSuppressed(verdictFor(withCode, 2, 2), withCode)).toBe(true);
        expect(inlineSuppressed(verdictFor(noReason, 2, 2), noReason)).toBe(false);
        expect(inlineSuppressed(verdictFor(noMarker, 1, 1), noMarker)).toBe(false);
    });

    it('honours a configured marker name', () => {
        const lines = ['// custom-ignore demo/no-console-log -- reason', 'console.log(1);'];
        expect(inlineSuppressed(verdictFor(lines, 2, 2), lines, 'custom-ignore')).toBe(true);
        expect(inlineSuppressed(verdictFor(lines, 2, 2), lines, 'jevcheck-ignore')).toBe(false);
    });
});

describe('readBaseline / writeBaseline', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'jevcheck-baseline-test-'));
        path = join(dir, 'baseline.json');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('returns an empty array when the file does not exist', () => {
        expect(readBaseline(path)).toEqual([]);
    });

    it('replaces only entries for scanned files × selected rules, keeps the rest', () => {
        writeBaseline(path, new Set(['a.ts']), new Set(['rule-x']), [{ rule: 'rule-x', file: 'a.ts', fingerprint: 'fp1' }]);
        writeBaseline(path, new Set(['b.ts']), new Set(['rule-y']), [{ rule: 'rule-y', file: 'b.ts', fingerprint: 'fp2' }]);
        const entries = readBaseline(path);
        expect(entries).toHaveLength(2);
        // Re-running rule-x over a.ts with zero current hits drops its old entry, keeps rule-y's.
        writeBaseline(path, new Set(['a.ts']), new Set(['rule-x']), []);
        expect(readBaseline(path)).toEqual([{ rule: 'rule-y', file: 'b.ts', fingerprint: 'fp2' }]);
    });
});
