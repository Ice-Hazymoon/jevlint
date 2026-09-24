import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeCalibration } from '../src/calibration.js';

describe('mergeCalibration', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'jevcheck-calibration-test-'));
        path = join(dir, 'calibration.json');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('starts from an empty answers object when the file does not exist', () => {
        const result = mergeCalibration(path, 'model-a', 'gateway', { 'rule/x': 0.9 });
        expect(result).toEqual({ model: 'model-a', provider: 'gateway', answers: { 'rule/x': 0.9 } });
    });

    it('merges a scoped run onto the existing file instead of replacing it — the bug this module exists to prevent', () => {
        writeFileSync(path, JSON.stringify({ model: 'model-a', provider: 'gateway', answers: { 'rule/a': 0.1, 'rule/b': 0.2 } }));
        // A scoped run only re-measured rule/b; rule/a must survive untouched.
        const result = mergeCalibration(path, 'model-a', 'gateway', { 'rule/b': 0.99 });
        expect(result.answers).toEqual({ 'rule/a': 0.1, 'rule/b': 0.99 });
    });

    it('always uses the current run\'s model/provider label, even if the file recorded a different one', () => {
        writeFileSync(path, JSON.stringify({ model: 'old-model', provider: 'typesafe', answers: { 'rule/a': 0.5 } }));
        const result = mergeCalibration(path, 'new-model', 'gateway', {});
        expect(result.model).toBe('new-model');
        expect(result.provider).toBe('gateway');
    });
});
