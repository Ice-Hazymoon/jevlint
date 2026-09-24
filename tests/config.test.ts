import type { JevRule } from '../src/types.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineConfig, JevcheckConfigError, loadConfig, resolveConfig } from '../src/config.js';

const rule: JevRule = { id: 'demo/rule', severity: 'warning', status: 'owned', why: 'w', files: ['**/*.ts'], question: 'q', criteria: { true: 't', false: 'f' }, fix: 'f' };

describe('defineConfig', () => {
    it('returns a valid config unchanged', () => {
        const config = defineConfig({ rules: [rule] });
        expect(config.rules).toEqual([rule]);
    });

    it('rejects an unknown top-level key with a did-you-mean suggestion', () => {
        expect(() => defineConfig({ rules: [rule], includ: ['**/*.ts'] } as never)).toThrow(/unknown key "includ" \(did you mean "include"\?\)/);
    });

    it('rejects duplicate rule ids', () => {
        expect(() => defineConfig({ rules: [rule, { ...rule }] })).toThrow(/Duplicate rule id/);
    });
});

describe('resolveConfig', () => {
    it('fills in every default and resolves paths relative to root', () => {
        const resolved = resolveConfig({ rules: [rule] }, '/project');
        expect(resolved.fixtures).toBe('/project/jevcheck/fixtures');
        expect(resolved.calibration).toBe('/project/jevcheck/calibration.json');
        expect(resolved.baseline).toBe('/project/jevcheck/baseline.json');
        expect(resolved.suppression).toBe('jevcheck-ignore');
        expect(resolved.cacheDir.endsWith('/jevcheck')).toBe(true);
    });

    it('honours explicit overrides and resolves a relative cacheDir against root, a tilde one against the home directory', () => {
        const resolved = resolveConfig({ rules: [rule], fixtures: 'fx', suppression: 'my-ignore', cacheDir: '~/custom-cache' }, '/project');
        expect(resolved.fixtures).toBe('/project/fx');
        expect(resolved.suppression).toBe('my-ignore');
        expect(resolved.cacheDir).toBe(join(homedir(), 'custom-cache'));
        expect(resolveConfig({ rules: [rule], cacheDir: '.jevcheck-cache' }, '/project').cacheDir).toBe('/project/.jevcheck-cache');
    });

    it('reports every invalid rule field at once, naming the rule', () => {
        const bad = { ...rule, severity: 'fatal', files: [], threshold: 2, prefilter: 'console' } as unknown as JevRule;
        let message = '';
        try {
            resolveConfig({ rules: [bad] }, '/project');
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain('rules[0] ("demo/rule"): "severity" must be "error" or "warning".');
        expect(message).toContain('"files" must be a non-empty array of glob strings.');
        expect(message).toContain('"threshold" must be a number in (0, 1].');
        expect(message).toContain('"prefilter" must be a RegExp.');
    });

    it('rejects an unknown rule key with a suggestion, and an unknown provider kind', () => {
        expect(() => resolveConfig({ rules: [{ ...rule, questoin: 'q' } as JevRule] }, '/project')).toThrow(/unknown key "questoin" \(did you mean "question"\?\)/);
        expect(() => resolveConfig({ rules: [rule], provider: { kind: 'openai' } as never }, '/project')).toThrow(/provider.kind/);
    });

    it('rejects a suppression marker with spaces or punctuation that would break the inline-marker regex', () => {
        expect(() => resolveConfig({ rules: [rule], suppression: 'not a valid marker!' }, '/project')).toThrow(JevcheckConfigError);
    });
});

describe('loadConfig', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'jevcheck-config-test-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('finds and loads a jevcheck.config.ts by walking up from a nested cwd', async () => {
        // A plain object: a real config imports "jevcheck", which does not resolve from a temp directory.
        writeFileSync(join(dir, 'jevcheck.config.ts'), 'const config: { rules: unknown[] } = { rules: [] };\nexport default config;\n');
        const nested = join(dir, 'a', 'b');
        mkdirSync(nested, { recursive: true });
        const config = await loadConfig(undefined, nested);
        expect(config.root).toBe(dir);
        expect(config.rules).toEqual([]);
    });

    it('reports a config that fails to load, naming the file', async () => {
        writeFileSync(join(dir, 'jevcheck.config.ts'), 'export default { rules: [ };\n');
        await expect(loadConfig(undefined, dir)).rejects.toThrow(/Could not load .*jevcheck\.config\.ts/);
    });

    it('throws a clear error when no config file is found', async () => {
        await expect(loadConfig(undefined, dir)).rejects.toThrow(/No jevcheck\.config/);
    });

    it('throws when the config has no default export with a `rules` array', async () => {
        writeFileSync(join(dir, 'jevcheck.config.mjs'), 'export const notDefault = { rules: [] };\n');
        await expect(loadConfig(undefined, dir)).rejects.toThrow(/must default-export a config/);
    });
});
