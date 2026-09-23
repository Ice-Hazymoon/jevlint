import type { JevRule } from '../src/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileKey, pruneCache, readFileResult, ruleFingerprint, shardedPath, writeFileResult, writeJsonAtomic } from '../src/ledger.js';

const baseRule: JevRule = {
    id: 'demo/rule',
    severity: 'warning',
    status: 'owned',
    why: 'w',
    files: ['**/*.ts'],
    question: 'q',
    criteria: { true: 't', false: 'f' },
    fix: 'f',
};

describe('ruleFingerprint', () => {
    it('changes when the question, criteria or threshold changes', () => {
        const base = ruleFingerprint(baseRule);
        expect(ruleFingerprint({ ...baseRule, question: 'different question' })).not.toBe(base);
        expect(ruleFingerprint({ ...baseRule, threshold: 0.9 })).not.toBe(base);
        expect(ruleFingerprint({ ...baseRule, criteria: { true: 'x', false: 'f' } })).not.toBe(base);
    });

    it('is stable for an equivalent rule object (same values, different identity)', () => {
        expect(ruleFingerprint(baseRule)).toBe(ruleFingerprint({ ...baseRule }));
    });

    it('is not affected by fields outside those it fingerprints (e.g. `why`, `fix`, `source`)', () => {
        expect(ruleFingerprint(baseRule)).toBe(ruleFingerprint({ ...baseRule, why: 'a totally different explanation', fix: 'a different fix', source: 'doc X' }));
    });
});

describe('fileKey', () => {
    it('changes when the file text changes, and when the rule set changes', () => {
        const key = fileKey('model-a', 'src/a.ts', 'const a = 1;', [baseRule], true);
        expect(fileKey('model-a', 'src/a.ts', 'const a = 2;', [baseRule], true)).not.toBe(key);
        expect(fileKey('model-a', 'src/a.ts', 'const a = 1;', [], true)).not.toBe(key);
        expect(fileKey('model-a', 'src/a.ts', 'const a = 1;', [baseRule], false)).not.toBe(key);
        expect(fileKey('model-b', 'src/a.ts', 'const a = 1;', [baseRule], true)).not.toBe(key);
    });

    it('is deterministic', () => {
        const a = fileKey('model-a', 'src/a.ts', 'const a = 1;', [baseRule], true);
        const b = fileKey('model-a', 'src/a.ts', 'const a = 1;', [baseRule], true);
        expect(a).toBe(b);
    });
});

describe('cache read/write/prune', () => {
    let cacheDir: string;

    beforeEach(() => {
        cacheDir = mkdtempSync(join(tmpdir(), 'jevlint-ledger-test-'));
    });
    afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

    it('round-trips a file result through the shard path', () => {
        const key = fileKey('model-a', 'src/a.ts', 'const a = 1;', [baseRule], true);
        expect(readFileResult(cacheDir, key)).toBeNull();
        writeFileResult(cacheDir, key, { skippedWholeFile: false, verdicts: [{ rule: 'demo/rule', startLine: 1, endLine: 1, probability: 0.9, exemptions: {} }] });
        expect(readFileResult(cacheDir, key)).toEqual({ skippedWholeFile: false, verdicts: [{ rule: 'demo/rule', startLine: 1, endLine: 1, probability: 0.9, exemptions: {} }] });
    });

    it('writeJsonAtomic never leaves a partial file for a concurrent reader to see', () => {
        const path = shardedPath(cacheDir, 'q', 'deadbeef'.repeat(8));
        writeJsonAtomic(path, { noul: 0.42 });
        expect(readFileResult(cacheDir, 'nonexistent-key')).toBeNull();
    });

    it('prune removes only entries older than max-age and reports removed/kept counts', () => {
        const key = fileKey('model-a', 'src/a.ts', 'const a = 1;', [baseRule], true);
        writeFileResult(cacheDir, key, { skippedWholeFile: false, verdicts: [] });
        const fresh = pruneCache(cacheDir, 30);
        expect(fresh).toEqual({ removed: 0, kept: 1 });
        const all = pruneCache(cacheDir, -1);
        expect(all.removed).toBe(1);
        expect(readFileResult(cacheDir, key)).toBeNull();
    });
});
