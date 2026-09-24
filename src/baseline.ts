import type { JevVerdict } from './types.js';
/**
 * Known-hit handling, so a post-edit scan reports what the edit introduced
 * instead of a file's whole backlog.
 *
 *   baseline file   committed fingerprints of accepted backlog hits (`jevcheck baseline`).
 *                   A fingerprint covers the rule, the file and the normalized text of the
 *                   located range, so edits elsewhere in the file keep it matched, while
 *                   touching the flagged lines makes the hit report again (fail-safe).
 *   inline marker   `// <suppression> <rule id or short code> -- <reason>` inside, or on the
 *                   line above, the reported range. A marker without a reason is ignored.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface BaselineEntry { rule: string; file: string; fingerprint: string }

/** Default inline-suppression marker name, e.g. `// jevcheck-ignore <id> -- <reason>`. */
export const DEFAULT_SUPPRESSION_MARKER = 'jevcheck-ignore';

function rangeOf(verdict: JevVerdict): { startLine: number; endLine: number } {
    return verdict.located ?? verdict.chunk;
}

export function fingerprint(verdict: JevVerdict, fileLines: readonly string[]): string {
    const { startLine, endLine } = rangeOf(verdict);
    const text = fileLines.slice(startLine - 1, endLine).map(line => line.trim()).filter(Boolean).join('\n');
    return createHash('sha256').update(verdict.rule.id).update('\0').update(verdict.chunk.file).update('\0').update(text).digest('hex').slice(0, 20);
}

/**
 * The rule id, or the short code named at the end of `source` (`"... CODE"`), suppressed by a
 * marker with a reason. `marker` is the suppression name from config (default `jevcheck-ignore`).
 */
export function inlineSuppressed(verdict: JevVerdict, fileLines: readonly string[], marker: string = DEFAULT_SUPPRESSION_MARKER): boolean {
    const { startLine, endLine } = rangeOf(verdict);
    const pattern = new RegExp(`${marker}\\s+([\\w./-]+)\\s+--\\s+\\S`);
    const code = verdict.rule.source?.trim().split(/\s+/).pop();
    for (const line of fileLines.slice(Math.max(0, startLine - 2), endLine)) {
        const named = pattern.exec(line)?.[1];
        if (named && (named === verdict.rule.id || (code && named === code))) { return true; }
    }
    return false;
}

export function readBaseline(path: string): BaselineEntry[] {
    if (!existsSync(path)) { return []; }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed as BaselineEntry[] : [];
}

/** Replace the entries of the scanned files × selected rules with the current hits; keep everything else. */
export function writeBaseline(path: string, scannedFiles: ReadonlySet<string>, selectedRules: ReadonlySet<string>, current: readonly BaselineEntry[]): number {
    const kept = readBaseline(path).filter(entry => !(scannedFiles.has(entry.file) && selectedRules.has(entry.rule)));
    const next = [...kept, ...current].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.fingerprint.localeCompare(b.fingerprint));
    writeFileSync(path, `${JSON.stringify(next, null, 1)}\n`);
    return next.length;
}
