import type { JevRule } from './types.js';
/**
 * Scan-once ledger. A file's verdicts are stored under a key made of
 * everything that can change them: engine version, model, path, content,
 * and the fingerprint of every rule in play. Same key → the stored verdicts
 * are replayed with no chunking and no request; any edit to the file or to
 * a rule changes the key.
 *
 * The store is content-addressed and lives outside the project (the
 * configured `cacheDir`, `~/.cache/jevlint` by default), so every checkout
 * and every concurrent process shares it, and because entries are immutable
 * files there is no shared mutable state to lock or corrupt.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Bump when chunking, window pass or verdict composition changes meaning. */
export const ENGINE_VERSION = '5';

export interface StoredVerdict {
    rule: string;
    startLine: number;
    endLine: number;
    probability: number;
    exemptions: Record<string, number>;
    located?: { startLine: number; endLine: number; probability: number };
}

export interface StoredFileResult { verdicts: StoredVerdict[]; skippedWholeFile: boolean }

export function defaultCacheDir(): string {
    return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'jevlint');
}

export function shardedPath(cacheDir: string, kind: 'q' | 'f', hash: string): string {
    const dir = join(cacheDir, kind, hash.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    return join(dir, `${hash}.json`);
}

/** Atomic publish: concurrent processes may compute the same entry; last rename wins with identical content. */
export function writeJsonAtomic(path: string, value: unknown): void {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, path);
}

export function ruleFingerprint(rule: JevRule): string {
    return JSON.stringify([
        rule.id,
        rule.question,
        rule.criteria,
        rule.exemptions ?? [],
        rule.threshold ?? null,
        rule.wholeFile ?? false,
        rule.files,
        rule.exclude ?? [],
        rule.prefilter?.source ?? null,
        rule.filePrefilter?.source ?? null,
        rule.unless?.source ?? null,
        rule.prepare?.toString() ?? null,
        rule.candidates ?? null,
    ]);
}

export function fileKey(model: string, file: string, text: string, rules: readonly JevRule[], locate: boolean): string {
    const hash = createHash('sha256');
    for (const part of [ENGINE_VERSION, model, String(locate), file, text, ...rules.map(ruleFingerprint)]) { hash.update(part).update('\0'); }
    return hash.digest('hex');
}

export function readFileResult(cacheDir: string, key: string): StoredFileResult | null {
    const path = shardedPath(cacheDir, 'f', key);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) as StoredFileResult : null;
}

export function writeFileResult(cacheDir: string, key: string, result: StoredFileResult): void {
    writeJsonAtomic(shardedPath(cacheDir, 'f', key), result);
}

/** Entries are never invalidated, only orphaned by new keys; drop the ones nobody has read or written recently. */
export function pruneCache(cacheDir: string, maxAgeDays: number): { removed: number; kept: number } {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let removed = 0;
    let kept = 0;
    for (const kind of ['q', 'f']) {
        const base = join(cacheDir, kind);
        if (!existsSync(base)) { continue; }
        for (const shard of readdirSync(base)) {
            for (const name of readdirSync(join(base, shard))) {
                const path = join(base, shard, name);
                if (statSync(path).mtimeMs < cutoff) {
                    rmSync(path);
                    removed++;
                } else {
                    kept++;
                }
            }
        }
    }
    return { removed, kept };
}
