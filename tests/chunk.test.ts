import { describe, expect, it } from 'vitest';
import { chunkFile, locateWindows } from '../src/chunk.js';

describe('chunkFile', () => {
    it('returns the whole file as one chunk when it is short', () => {
        const text = 'export function a(): void {}\nexport function b(): void {}\n';
        const chunks = chunkFile('src/a.ts', text);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toMatchObject({ file: 'src/a.ts', startLine: 1, endLine: text.split('\n').length });
    });

    it('packs top-level declarations of a large .ts file into several chunks carrying the import header', () => {
        const body = Array.from({ length: 40 }, (_, i) => `export function fn${i}(): number {\n    return ${i};\n}\n`).join('\n');
        const text = `import { readFileSync } from 'node:fs';\n\n${body}`;
        const chunks = chunkFile('src/big.ts', text);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) { expect(chunk.text).toContain('import { readFileSync } from \'node:fs\';'); }
    });

    it('splits a large .vue file into <script> and <template> spans', () => {
        const script = Array.from({ length: 200 }, (_, i) => `// line ${i}`).join('\n');
        const text = `<script setup lang="ts">\n${script}\n</script>\n<template>\n  <div />\n</template>\n`;
        const chunks = chunkFile('src/Big.vue', text);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every(chunk => chunk.file === 'src/Big.vue')).toBe(true);
    });
});

describe('locateWindows', () => {
    it('produces overlapping windows that cover the whole chunk range', () => {
        const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
        const windows = locateWindows(lines, { file: 'x.ts', startLine: 1, endLine: 100, text: '' });
        expect(windows[0]!.startLine).toBe(1);
        expect(windows.at(-1)!.endLine).toBe(100);
        for (let i = 1; i < windows.length; i++) { expect(windows[i]!.startLine).toBeLessThanOrEqual(windows[i - 1]!.endLine); }
    });
});
