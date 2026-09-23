/**
 * Calibration-file merge logic, split out so it can be unit-tested without
 * importing the CLI entry point.
 *
 * `test --record` merges this run's fixture probabilities into whatever is
 * already on disk instead of replacing the file outright: a scoped run
 * (`--rules=<id,id>`, or any filter that narrows which rules are tested)
 * only answers a subset of the rule set, so writing just that subset over
 * the committed file would silently delete every other rule's recorded
 * calibration.
 */
import { existsSync, readFileSync } from 'node:fs';

export interface Calibration { model: string; provider: string; answers: Record<string, number> }

/**
 * Reads `path` (if it exists) and returns a new calibration object whose
 * `answers` is the file's existing answers overlaid with `updates` — keys not
 * touched by this run are preserved; keys this run re-measured are replaced.
 * `model`/`provider` are always the CURRENT run's (an unpinned gateway model
 * moving is exactly what `test --drift` exists to detect against the merged file).
 */
export function mergeCalibration(path: string, model: string, provider: string, updates: Readonly<Record<string, number>>): Calibration {
    const existing: Record<string, number> = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as Calibration).answers ?? {} : {};
    return { model, provider, answers: { ...existing, ...updates } };
}
