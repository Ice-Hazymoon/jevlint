/**
 * Publish gate: nothing in the package tree (source, tests, docs, workflow, built `dist/`) or in the
 * `npm pack` file list may carry a credential, and the tarball may only contain what users need.
 *
 * Maintainers can add their own forbidden terms without committing them: point
 * JEVLINT_FORBIDDEN_TERMS at a file with one case-insensitive regular expression per line.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

const SECRET_PATTERNS: readonly RegExp[] = [
    /\bsk-[\w-]{16,}/,
    /\bghp_\w{20,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /api[_-]?key\s*[:=]\s*['"][^'"]{12,}/i,
    /Bearer [A-Za-z0-9]/,
];

const extraTerms: readonly RegExp[] = process.env.JEVLINT_FORBIDDEN_TERMS
    ? readFileSync(process.env.JEVLINT_FORBIDDEN_TERMS, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean).map(line => new RegExp(line, 'i'))
    : [];

function listFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git') { continue; }
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { listFiles(full, out); } else { out.push(relative(ROOT, full)); }
    }
    return out;
}

function packedFiles(): string[] {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (JSON.parse(output) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map(file => file.path);
}

describe('publish-clean', () => {
    const files = listFiles(ROOT).filter(file => file !== SELF);

    it.each(files)('%s has no credential or forbidden term', (file) => {
        const text = readFileSync(join(ROOT, file), 'utf-8');
        for (const pattern of [...SECRET_PATTERNS, ...extraTerms]) {
            const match = pattern.exec(text);
            expect(match, `${file} matches ${pattern}: ${JSON.stringify(match?.[0])}`).toBeNull();
        }
    });

    it('packs only the built package, readme, changelog and license', () => {
        const packed = packedFiles();
        const unexpected = packed.filter(file => !/^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|dist\/[\w.-]+\.(?:mjs|d\.mts))$/.test(file));
        expect(unexpected).toEqual([]);
        for (const file of packed) {
            for (const pattern of extraTerms) { expect(pattern.test(file), `packed path ${file} matches ${pattern}`).toBe(false); }
        }
        if (existsSync(join(ROOT, 'dist'))) { expect(packed).toEqual(expect.arrayContaining(['dist/bin.mjs', 'dist/index.mjs', 'dist/index.d.mts', 'dist/mutate.mjs', 'dist/prepare.mjs'])); }
    });
});
