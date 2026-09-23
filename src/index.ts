/**
 * jevlint: semantic lint rules answered as calibrated yes/no probabilities.
 *
 * - `defineConfig` / `defineRule` type a `jevlint.config.ts`.
 * - `loadConfig` + `createJevlint` run scans, fixture tests and recall probes from code.
 *
 * @packageDocumentation
 */
export { createJevlint } from './api.js';
export type {
    JevlintApi,
    LintOptions,
    RecallMutantResult,
    RecallOptions,
    RecallResult,
    TestCaseResult,
    TestOptions,
    TestResult,
} from './api.js';
export { AstGrepRuleError } from './astGrep.js';
export { JevlintProviderKeyError, JevlintReplayMissError, JevlintRequestError } from './client.js';
export type { ClientStats, JevlintProviderConfig } from './client.js';
export { DEFAULT_IGNORE, DEFAULT_INCLUDE, defineConfig, JevlintConfigError, loadConfig, resolveConfig } from './config.js';
export type { JevlintConfig, ResolvedJevlintConfig } from './config.js';
export { formatStylish, jsonReporter, stylishReporter } from './reporters.js';
export type { JevlintReporter, LintRunResult, ReportedVerdict } from './reporters.js';
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
