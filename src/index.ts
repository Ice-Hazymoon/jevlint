/**
 * jevcheck: semantic lint rules answered as calibrated yes/no probabilities.
 *
 * - `defineConfig` / `defineRule` type a `jevcheck.config.ts`.
 * - `loadConfig` + `createJevcheck` run scans, fixture tests and recall probes from code.
 *
 * @packageDocumentation
 */
export { createJevcheck } from './api.js';
export type {
    JevcheckApi,
    LintOptions,
    RecallMutantResult,
    RecallOptions,
    RecallResult,
    TestCaseResult,
    TestOptions,
    TestResult,
} from './api.js';
export { AstGrepRuleError } from './astGrep.js';
export { JevcheckProviderKeyError, JevcheckReplayMissError, JevcheckRequestError } from './client.js';
export type { ClientStats, JevcheckProviderConfig } from './client.js';
export { DEFAULT_IGNORE, DEFAULT_INCLUDE, defineConfig, JevcheckConfigError, loadConfig, resolveConfig } from './config.js';
export type { JevcheckConfig, ResolvedJevcheckConfig } from './config.js';
export { formatStylish, jsonReporter, stylishReporter } from './reporters.js';
export type { JevcheckReporter, LintRunResult, ReportedVerdict } from './reporters.js';
export { defineRule } from './types.js';
export type {
    Chunk,
    JevExemption,
    JevMutant,
    JevRelatedCandidates,
    JevRule,
    JevRuleStatus,
    JevSeverity,
    JevVerdict,
} from './types.js';
export type { Claim, ClaimVerdict } from './verify.js';
