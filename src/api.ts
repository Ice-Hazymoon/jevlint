import type { JevClient } from './client.js';
import type { ResolvedJevlintConfig } from './config.js';
import type { JevlintReporter, LintRunResult, ReportedVerdict } from './reporters.js';
import type { JevRule, JevVerdict } from './types.js';
import type { Claim, ClaimVerdict } from './verify.js';
/**
 * Programmatic API. The CLI is a thin layer over `createJevlint`; everything it does is available here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint, inlineSuppressed, readBaseline, writeBaseline } from './baseline.js';
import { buildCandidateMaps, matchesGlobs } from './candidates.js';
import { createJevClient } from './client.js';
import { DEFAULT_THRESHOLD, exemptedBy, judgeFile, REVIEW_FLOOR, selectRules } from './engine.js';
import { runFixtures, runRecall } from './evaluate.js';
import { pruneCache as pruneCacheStore } from './ledger.js';
import { verifyClaims } from './verify.js';

/** Options for `lint`. */
export interface LintOptions {
    /** Rule ids or id prefixes (`"group/"`) to run. Default: every rule. */
    rules?: readonly string[];
    /** Only rules with `status: 'owned'`. */
    owned?: boolean;
    /** Drop hits recorded in the baseline file. Default true. Inline suppressions always apply. */
    useBaseline?: boolean;
    /** Ask again instead of using cached answers and cached file verdicts. */
    noCache?: boolean;
    /** Skip the pass that narrows a chunk-level hit to a smaller line range. */
    noLocate?: boolean;
    /** Ignore `prefilter` / `unless` gates, to find violations a gate hides. Bypasses cached file verdicts. */
    noPrefilter?: boolean;
    /** Also return verdicts between 0.5 and the threshold in `review`. */
    review?: boolean;
}

/** Options for `test`. */
export interface TestOptions {
    /** Rule ids or id prefixes to test. Default: every rule. */
    rules?: readonly string[];
    /** Merge this run's fixture probabilities into the calibration file. */
    record?: boolean;
    /** Re-ask every fixture with no cache and report drift against the calibration file. */
    drift?: boolean;
}

/** One fixture's outcome. */
export interface TestCaseResult {
    /** `<rule id>/<fixture file name>`. */
    key: string;
    ok: boolean;
    /** Probability and exemption answers, as printed by the CLI. */
    detail: string;
    /** Undefined when the fixture was never sent (outside the rule's scope or prefilter). */
    probability?: number;
    /** Passed, but by less than 0.05. */
    thinMargin?: boolean;
}

/** Result of `test`. */
export interface TestResult {
    cases: readonly TestCaseResult[];
    failures: number;
    missingFixtures: readonly string[];
    neverAsked: number;
    thin: readonly TestCaseResult[];
    drift?: { meanAbsoluteDelta: number; moved: ReadonlyArray<{ key: string; before: number; after: number }> };
    recorded?: { fixtureAnswers: number; totalAnswers: number };
    requests: number;
    inputTokens: number;
}

/** Options for `recall`. */
export interface RecallOptions {
    /** Rule ids or id prefixes to measure. Default: every rule with mutants. */
    rules?: readonly string[];
    /** Candidate files to mutate, relative to the config root (normally every tracked file). */
    files: readonly string[];
    /** Files judged per mutant. Default 12. */
    sampleSize?: number;
    /** List mutable files per mutant without asking anything. */
    dry?: boolean;
}

/** One mutant's outcome: how many injected violations were caught. */
export interface RecallMutantResult {
    rule: string;
    mutant: string;
    caught: number;
    judged: number;
    candidateCount: number;
    recall?: number;
    graduates?: boolean;
    misses: readonly string[];
    invalidMutants: readonly string[];
}

/** Result of `recall`. */
export interface RecallResult {
    mutants: readonly RecallMutantResult[];
    weakestRecall: number;
    requests: number;
    inputTokens: number;
}

/** What `createJevlint` returns. File paths are relative to `config.root`. */
export interface JevlintApi {
    /** Judges `files` with the selected rules and calls the config's reporters with the result. */
    lint: (files: readonly string[], opts?: LintOptions) => Promise<LintRunResult>;
    /** Runs every selected rule against its fixtures. */
    test: (opts?: TestOptions) => Promise<TestResult>;
    /** Injects each rule's mutants into real files and measures how many are caught. */
    recall: (opts: RecallOptions) => Promise<RecallResult>;
    /** Replaces the baseline entries for these files and rules with the current hits. */
    baseline: (files: readonly string[], opts?: Pick<LintOptions, 'rules' | 'owned'>) => Promise<{ hitsWritten: number; totalEntries: number }>;
    /** The rules a `rules` / `owned` selection resolves to. Throws on an unknown id. */
    listRules: (opts?: Pick<LintOptions, 'rules' | 'owned'>) => readonly JevRule[];
    /** Checks statements about code against the lines they cite. */
    verify: (claims: readonly Claim[]) => Promise<{ verdicts: readonly ClaimVerdict[]; requests: number; inputTokens: number }>;
    /** Deletes cache entries not used within `maxAgeDays` (default 30). */
    pruneCache: (maxAgeDays?: number) => { removed: number; kept: number };
    readonly config: ResolvedJevlintConfig;
}

function toReported(v: JevVerdict): ReportedVerdict {
    const range = v.located ?? v.chunk;
    return { file: v.chunk.file, startLine: range.startLine, endLine: range.endLine, rule: v.rule.id, source: v.rule.source, severity: v.rule.severity, status: v.rule.status, why: v.rule.why, probability: v.probability, fix: v.rule.fix, confirm: v.rule.confirm };
}

async function runReporters(reporters: readonly JevlintReporter[], result: LintRunResult): Promise<void> {
    for (const reporter of reporters) { await reporter.onRunComplete(result); }
}

/**
 * Creates an engine for a resolved config (from `loadConfig`, or `resolveConfig` for a config built in code).
 *
 * @example
 * const jevlint = createJevlint(await loadConfig());
 * const { hits } = await jevlint.lint(['src/server.ts']);
 */
export function createJevlint(config: ResolvedJevlintConfig): JevlintApi {
    const readText = (file: string): string => readFileSync(join(config.root, file), 'utf-8');
    const fileLinesCache = new Map<string, string[]>();
    const linesOf = (file: string): string[] => fileLinesCache.get(file) ?? fileLinesCache.set(file, readText(file).split('\n')).get(file)!;

    function client(useCache: boolean): JevClient {
        return createJevClient({ cacheDir: config.cacheDir, useCache, provider: config.provider, concurrency: config.concurrency, tokensPerSecond: config.tokensPerSecond });
    }

    function inScope(files: readonly string[]): readonly string[] {
        return files.filter(file => matchesGlobs(config.include, file) && !matchesGlobs(config.ignore, file));
    }

    async function lint(files: readonly string[], opts: LintOptions = {}): Promise<LintRunResult> {
        const selected = selectRules(config.rules, { ids: opts.rules, owned: opts.owned });
        const scanned = inScope(files);
        const jevClient = client(!opts.noCache);
        const candidateMaps = buildCandidateMaps(config.root, selected, scanned);
        const results = await Promise.all(scanned.map(file => judgeFile(file, readText(file), selected, {
            client: jevClient,
            model: jevClient.provider.model,
            cacheDir: config.cacheDir,
            useLedger: !opts.noCache && !opts.noPrefilter,
            noLocate: Boolean(opts.noLocate),
            noPrefilter: Boolean(opts.noPrefilter),
            candidateMaps,
        })));
        const verdicts = results.flatMap(r => r.verdicts);
        const skipped = scanned.filter((_, index) => results[index]?.skippedWholeFile);
        const replayed = results.filter(r => r.replayed).length;
        const chunkCount = results.reduce((sum, r) => sum + r.chunks, 0);
        const fired = verdicts.filter(v => v.probability >= (v.rule.threshold ?? DEFAULT_THRESHOLD));
        const unexempted = fired.filter(v => !exemptedBy(v));
        const exempted = fired.filter(v => exemptedBy(v));
        const useBaseline = opts.useBaseline ?? true;
        const known = new Set(useBaseline ? readBaseline(config.baseline).map(entry => `${entry.rule}\0${entry.file}\0${entry.fingerprint}`) : []);
        const suppressed = unexempted.filter(v => inlineSuppressed(v, linesOf(v.chunk.file), config.suppression));
        const baselined = unexempted.filter(v => !suppressed.includes(v) && known.has(`${v.rule.id}\0${v.chunk.file}\0${fingerprint(v, linesOf(v.chunk.file))}`));
        const hits = unexempted.filter(v => !suppressed.includes(v) && !baselined.includes(v));
        const review = opts.review ? verdicts.filter(v => v.probability >= REVIEW_FLOOR && !fired.includes(v)) : [];
        const result: LintRunResult = {
            model: jevClient.provider.model,
            provider: jevClient.provider.name,
            hits: hits.map(toReported),
            review: review.map(toReported),
            exempted: exempted.map(v => ({ ...toReported(v), exemptedBy: exemptedBy(v), exemptions: v.exemptions })),
            baselinedCount: baselined.length,
            suppressedInlineCount: suppressed.length,
            skippedWholeFile: skipped,
            replayedFiles: replayed,
            filesScanned: scanned.length,
            chunkCount,
            stats: jevClient.stats,
        };
        await runReporters(config.reporters, result);
        return result;
    }

    async function baseline(files: readonly string[], opts: Pick<LintOptions, 'rules' | 'owned'> = {}): Promise<{ hitsWritten: number; totalEntries: number }> {
        const result = await lint(files, { ...opts, useBaseline: false });
        const selected = selectRules(config.rules, { ids: opts.rules, owned: opts.owned });
        const total = writeBaseline(config.baseline, new Set(inScope(files)), new Set(selected.map(rule => rule.id)), result.hits.map(hit => ({ rule: hit.rule, file: hit.file, fingerprint: fingerprint({ rule: selected.find(r => r.id === hit.rule)!, chunk: { file: hit.file, startLine: hit.startLine, endLine: hit.endLine, text: '' }, probability: hit.probability, exemptions: {} }, linesOf(hit.file)) })));
        return { hitsWritten: result.hits.length, totalEntries: total };
    }

    function listRules(opts: Pick<LintOptions, 'rules' | 'owned'> = {}): readonly JevRule[] {
        return selectRules(config.rules, { ids: opts.rules, owned: opts.owned });
    }

    function test(opts: TestOptions = {}): Promise<TestResult> {
        return runFixtures(config, client(!opts.drift), opts);
    }

    function recall(opts: RecallOptions): Promise<RecallResult> {
        return runRecall(config, client(true), opts);
    }

    async function verify(claims: readonly Claim[]): Promise<{ verdicts: readonly ClaimVerdict[]; requests: number; inputTokens: number }> {
        const jevClient = client(true);
        const verdicts = await verifyClaims(jevClient, config.root, claims);
        return { verdicts, requests: jevClient.stats.requests, inputTokens: jevClient.stats.inputTokens };
    }

    function pruneCache(maxAgeDays = 30): { removed: number; kept: number } {
        return pruneCacheStore(config.cacheDir, maxAgeDays);
    }

    return { lint, test, recall, baseline, listRules, verify, pruneCache, config };
}
