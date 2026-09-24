/**
 * The package must work as a standalone install: source files import only Node built-ins, the
 * dependencies package.json declares, and files inside the package.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
// The package's own name appears in `jevcheck init`'s generated config text.
const DECLARED = new Set([manifest.name, ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);

function listTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { listTsFiles(full, out); } else if (entry.endsWith('.ts')) { out.push(full); }
    }
    return out;
}

function specifiers(source: string): string[] {
    return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => (match[1] ?? match[2])!);
}

describe('imports stay inside the package', () => {
    const files = ['src', 'bin'].flatMap(dir => listTsFiles(join(ROOT, dir)));

    it.each(files.map(file => relative(ROOT, file)))('%s', (file) => {
        for (const specifier of specifiers(readFileSync(join(ROOT, file), 'utf-8'))) {
            if (specifier.startsWith('node:')) { continue; }
            if (!specifier.startsWith('.')) {
                expect(DECLARED.has(specifier), `${file} imports undeclared package "${specifier}"`).toBe(true);
                continue;
            }
            expect(resolve(dirname(join(ROOT, file)), specifier).startsWith(ROOT), `${file} imports "${specifier}" from outside the package`).toBe(true);
        }
    });
});
