import type { Chunk } from './types.js';
/**
 * Split a source file into chunks Jev can judge well. Small files go whole;
 * large files are packed by top-level declaration, each chunk carrying the
 * import header so identifiers keep their meaning. Irrelevant context lowers
 * judgment accuracy ("context rot"), so smaller, coherent state beats one big blob.
 */
import ts from 'typescript';

// Calibrated on real services: large chunks routinely hold several loops/handlers, so an
// exemption true for one construct masks a violation in its neighbour.
const WHOLE_FILE_MAX_LINES = 150;
const CHUNK_TARGET_LINES = 90;
const HEADER_MAX_LINES = 60;
export const LOCATE_WINDOW_LINES = 40;
const LOCATE_WINDOW_OVERLAP = 14;

interface Span { startLine: number; endLine: number }

function sliceLines(lines: readonly string[], span: Span): string {
    return lines.slice(span.startLine - 1, span.endLine).join('\n');
}

function topLevelSpans(file: string, text: string): { header: Span | null; bodies: Span[] } {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
    let headerEnd = 0;
    let previousEnd = 0;
    const bodies: Span[] = [];
    for (const statement of source.statements) {
        // Start right after the previous statement so leading comments stay attached to their declaration.
        const span = { startLine: previousEnd + 1, endLine: lineOf(statement.getEnd()) };
        previousEnd = span.endLine;
        if (ts.isImportDeclaration(statement) && bodies.length === 0) {
            headerEnd = span.endLine;
        } else { bodies.push(span); }
    }
    return { header: headerEnd > 0 ? { startLine: 1, endLine: Math.min(headerEnd, HEADER_MAX_LINES) } : null, bodies };
}

function vueSpans(lines: readonly string[]): Span[] {
    const spans: Span[] = [];
    let open: { tag: string; line: number } | null = null;
    for (const [index, line] of lines.entries()) {
        if (!open) {
            const match = /^<(script|template)\b/.exec(line);
            if (match?.[1]) { open = { tag: match[1], line: index + 1 }; }
        } else if (line.startsWith(`</${open.tag}>`)) {
            spans.push({ startLine: open.line, endLine: index + 1 });
            open = null;
        }
    }
    return spans;
}

function pack(spans: readonly Span[]): Span[] {
    const packed: Span[] = [];
    for (const span of spans) {
        const last = packed.at(-1);
        if (last && span.endLine - last.startLine + 1 <= CHUNK_TARGET_LINES) {
            last.endLine = span.endLine;
        } else { packed.push({ ...span }); }
    }
    return packed;
}

/** One `<script>` / `<template>` span of a Vue SFC; a large `<script>` is packed by top-level statement like a .ts file. */
function chunkVueSpan(file: string, lines: readonly string[], span: Span): Chunk[] {
    const plain = [{ file, ...span, text: sliceLines(lines, span) }];
    const isScript = /^<script\b/.test(lines[span.startLine - 1] ?? '');
    if (!isScript || span.endLine - span.startLine + 1 <= WHOLE_FILE_MAX_LINES) { return plain; }
    // A one-token rule drowns in a large <script>: pack its top-level statements like a .ts file.
    const inner = { startLine: span.startLine + 1, endLine: span.endLine - 1 };
    const { header, bodies } = topLevelSpans(`${file}.ts`, sliceLines(lines, inner));
    if (bodies.length === 0) { return plain; }
    const offset = inner.startLine - 1;
    const shift = (item: Span): Span => ({ startLine: item.startLine + offset, endLine: item.endLine + offset });
    const headerText = header ? `${sliceLines(lines, shift(header))}\n// …\n` : '';
    return pack(bodies).map(body => ({ file, ...shift(body), text: `<script setup lang="ts">\n${headerText}${sliceLines(lines, shift(body))}` }));
}

function chunkTypeScript(file: string, text: string, lines: readonly string[]): Chunk[] | undefined {
    const { header, bodies } = topLevelSpans(file, text);
    if (bodies.length === 0) { return undefined; }
    const headerText = header ? `${sliceLines(lines, header)}\n// …\n` : '';
    return pack(bodies).map(span => ({ file, ...span, text: headerText + sliceLines(lines, span) }));
}

export function chunkFile(file: string, text: string): Chunk[] {
    const lines = text.split('\n');
    const whole: Chunk = { file, startLine: 1, endLine: lines.length, text };
    if (lines.length <= WHOLE_FILE_MAX_LINES) { return [whole]; }
    if (file.endsWith('.vue')) {
        const spans = vueSpans(lines);
        return spans.length === 0 ? [whole] : spans.flatMap(span => chunkVueSpan(file, lines, span));
    }
    return (/\.[cm]?tsx?$/.test(file) ? chunkTypeScript(file, text, lines) : undefined) ?? [whole];
}

/** Overlapping line windows over a chunk's own range, for the localization pass. */
export function locateWindows(fileLines: readonly string[], chunk: Chunk): Array<Span & { text: string }> {
    const windows: Array<Span & { text: string }> = [];
    const step = LOCATE_WINDOW_LINES - LOCATE_WINDOW_OVERLAP;
    for (let start = chunk.startLine; start <= chunk.endLine; start += step) {
        const span = { startLine: start, endLine: Math.min(start + LOCATE_WINDOW_LINES - 1, chunk.endLine) };
        windows.push({ ...span, text: sliceLines(fileLines, span) });
        if (span.endLine === chunk.endLine) { break; }
    }
    return windows;
}
