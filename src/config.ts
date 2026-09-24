import type { JevlintProviderConfig } from './client.js';
import type { JevlintReporter } from './reporters.js';
import type { JevRule } from './types.js';
import { createJiti } from 'jiti';
/**
 * `jevlint.config.{ts,mts,js,mjs}` loading and validation.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AstGrepRuleError, validateAstGrepRule } from './astGrep.js';
import { defaultCacheDir } from './ledger.js';

/** The object a `jevlint.config.ts` default-exports. Only `rules` is required. */
export interface JevlintConfig {
    /** The rules to run. Ids must be unique. */
    rules: readonly JevRule[];
    /** Globs (relative to the config file) of files that may be scanned at all. Default: `DEFAULT_INCLUDE`. */
    include?: readonly string[];
    /** Globs never scanned, whatever `include` or a rule's `files` say. Default: `DEFAULT_IGNORE`. */
    ignore?: readonly string[];
    /** Fixture directory for `jevlint test`: `<rule id, "/" → "__">/{invalid,valid,exempt}-*.txt`. Default `jevlint/fixtures`. */
    fixtures?: string;
    /** File `jevlint test --record` writes fixture probabilities to. Default `jevlint/calibration.json`. */
    calibration?: string;
    /** File `jevlint baseline` writes accepted hits to. Default `jevlint/baseline.json`. */
    baseline?: string;
    /** Answer and verdict cache. `~` expands to the home directory. Default `$XDG_CACHE_HOME/jevlint` or `~/.cache/jevlint`. */
    cacheDir?: string;
    /** Inline suppression marker: `// <suppression> <rule id> -- <reason>`. Default `jevlint-ignore`. */
    suppression?: string;
    /** Where answers come from. Default: `gateway` when `AI_GATEWAY_API_KEY` is set, else `typesafe`. */
    provider?: JevlintProviderConfig;
    /** Maximum requests in flight. Default 48. */
    concurrency?: number;
    /** Input-token budget per second, estimated. Default 230000. */
    tokensPerSecond?: number;
    /** Called with the full result after every scan, in addition to the CLI's own output. */
    reporters?: readonly JevlintReporter[];
}

/** A config with every default filled in and every path absolute. Produced by `loadConfig` / `resolveConfig`. */
export interface ResolvedJevlintConfig {
    root: string;
    configPath?: string;
    rules: readonly JevRule[];
    include: readonly string[];
    ignore: readonly string[];
    fixtures: string;
    calibration: string;
    baseline: string;
    cacheDir: string;
    suppression: string;
    provider?: JevlintProviderConfig;
    concurrency?: number;
    tokensPerSecond?: number;
    reporters: readonly JevlintReporter[];
}

/** Default `include`: TypeScript and Vue single-file components. */
export const DEFAULT_INCLUDE: readonly string[] = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.vue'];
/** Default `ignore`: dependencies, build output, caches, declaration files and env files. */
export const DEFAULT_IGNORE: readonly string[] = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/.cache/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.output/**',
    '**/.svelte-kit/**',
    '**/.env*',
    '**/*.d.ts',
];

const CONFIG_FILE_NAMES = ['jevlint.config.ts', 'jevlint.config.mts', 'jevlint.config.js', 'jevlint.config.mjs'];
const CONFIG_KEYS = ['rules', 'include', 'ignore', 'fixtures', 'calibration', 'baseline', 'cacheDir', 'suppression', 'provider', 'concurrency', 'tokensPerSecond', 'reporters'];
const RULE_KEYS = ['id', 'source', 'severity', 'status', 'why', 'files', 'exclude', 'prefilter', 'filePrefilter', 'candidates', 'unless', 'wholeFile', 'question', 'criteria', 'exemptions', 'deterministicCandidate', 'prepare', 'mutants', 'threshold', 'confirm', 'fix'];

/** The config is malformed; the message names the field and what was expected. */
export class JevlintConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JevlintConfigError';
    }
}

function levenshtein(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) { current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! : 1 + Math.min(previous[j]!, current[j - 1]!, previous[j - 1]!); }
        previous = current;
    }
    return previous[b.length]!;
}

function unknownKeys(value: object, known: readonly string[], where: string): string | undefined {
    const unknown = Object.keys(value).filter(key => !known.includes(key));
    if (unknown.length === 0) { return undefined; }
    const hint = (key: string): string => {
        const best = known.map(name => ({ name, distance: levenshtein(key, name) })).sort((a, b) => a.distance - b.distance)[0];
        return best && best.distance <= 3 ? ` (did you mean "${best.name}"?)` : '';
    };
    return `${where}: unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map(key => `"${key}"${hint(key)}`).join(', ')}.`;
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Problems with a rule's ast-grep `candidates` rules. */
function candidateProblems(rule: JevRule, where: string): string[] {
    const problems: string[] = [];
    for (const [field, yaml] of [['candidates.rule', rule.candidates?.rule], ['candidates.related.rule', rule.candidates?.related?.rule]] as const) {
        try {
            if (yaml !== undefined) { validateAstGrepRule(yaml); }
        } catch (err: unknown) {
            if (!(err instanceof AstGrepRuleError)) { throw err; }
            problems.push(`${where}: "${field}" is not a valid ast-grep rule: ${err.message}`);
        }
    }
    const linkBy = rule.candidates?.related?.linkBy;
    if (linkBy !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(linkBy)) { problems.push(`${where}: "candidates.related.linkBy" must be a metavariable name without "$", e.g. "NAME".`); }
    return problems;
}

/** Every problem with one rule, as messages naming the field. */
function ruleProblems(rule: JevRule, index: number): string[] {
    const where = `rules[${index}]${isString(rule.id) ? ` ("${rule.id}")` : ''}`;
    const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
    const checks: Array<[boolean, string, string]> = [
        [isString(rule.id), 'id', 'a non-empty string'],
        [rule.severity === 'error' || rule.severity === 'warning', 'severity', '"error" or "warning"'],
        [rule.status === 'owned' || rule.status === 'shadow', 'status', '"owned" or "shadow"'],
        ...(['why', 'question', 'fix'] as const).map((field): [boolean, string, string] => [isString(rule[field]), field, 'a non-empty string']),
        [isString(rule.criteria?.true) && isString(rule.criteria?.false), 'criteria', 'an object with non-empty "true" and "false" strings'],
        [isStringList(rule.files) && rule.files.length > 0, 'files', 'a non-empty array of glob strings'],
        [optional(rule.exclude, isStringList), 'exclude', 'an array of glob strings'],
        ...(['prefilter', 'filePrefilter', 'unless'] as const).map((field): [boolean, string, string] => [optional(rule[field], value => value instanceof RegExp), field, 'a RegExp']),
        [optional(rule.threshold, value => typeof value === 'number' && value > 0 && value <= 1), 'threshold', 'a number in (0, 1]'],
    ];
    return [
        ...[unknownKeys(rule, RULE_KEYS, where) ?? []].flat(),
        ...checks.filter(([ok]) => !ok).map(([, field, expected]) => `${where}: "${field}" must be ${expected}.`),
        ...candidateProblems(rule, where),
    ];
}

/** Throws one `JevlintConfigError` listing every unknown key and invalid rule. */
function validate(config: JevlintConfig, where: string): void {
    const problems: string[] = [];
    const unknown = unknownKeys(config, CONFIG_KEYS, where);
    if (unknown) { problems.push(unknown); }
    const rules: unknown = config.rules;
    if (Array.isArray(rules)) {
        problems.push(...rules.flatMap((rule: JevRule, index) => (rule && typeof rule === 'object' ? ruleProblems(rule, index) : [`rules[${index}]: must be a rule object.`])));
        const seen = new Set<string>();
        for (const rule of rules as JevRule[]) {
            if (rule && seen.has(rule.id)) { problems.push(`Duplicate rule id "${rule.id}".`); }
            seen.add(rule?.id);
        }
    } else {
        problems.push('"rules" must be an array of rules (see defineRule).');
    }
    if (problems.length > 0) { throw new JevlintConfigError(problems.join('\n')); }
}

/**
 * Identity helper that gives a config file type checking and autocomplete. Also rejects unknown
 * keys and invalid rules early; paths are resolved later, by `loadConfig` / `resolveConfig`.
 */
export function defineConfig(config: JevlintConfig): JevlintConfig {
    validate(config, 'jevlint config');
    return config;
}

function expandHome(path: string): string {
    return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/**
 * Validates a config object and resolves it against `root` (normally the config file's
 * directory): defaults filled in, every path absolute.
 */
export function resolveConfig(config: JevlintConfig, root: string, configPath?: string): ResolvedJevlintConfig {
    validate(config, 'jevlint config');
    if (config.suppression !== undefined && !/^[\w-]+$/.test(config.suppression)) { throw new JevlintConfigError(`"suppression" must be a single word of letters, digits, "-" or "_", got "${config.suppression}".`); }
    for (const field of ['include', 'ignore'] as const) {
        if (config[field] !== undefined && !isStringList(config[field])) { throw new JevlintConfigError(`"${field}" must be an array of glob strings.`); }
    }
    const provider = config.provider?.kind;
    if (provider !== undefined && provider !== 'gateway' && provider !== 'typesafe' && provider !== 'replay') { throw new JevlintConfigError(`"provider.kind" must be "gateway", "typesafe" or "replay", got "${String(provider)}".`); }
    const path = (value: string | undefined, fallback: string): string => resolve(root, expandHome(value ?? fallback));
    return {
        root,
        configPath,
        rules: config.rules,
        include: config.include ?? DEFAULT_INCLUDE,
        ignore: config.ignore ?? DEFAULT_IGNORE,
        fixtures: path(config.fixtures, 'jevlint/fixtures'),
        calibration: path(config.calibration, 'jevlint/calibration.json'),
        baseline: path(config.baseline, 'jevlint/baseline.json'),
        cacheDir: config.cacheDir ? path(config.cacheDir, '') : defaultCacheDir(),
        suppression: config.suppression ?? 'jevlint-ignore',
        provider: config.provider,
        concurrency: config.concurrency,
        tokensPerSecond: config.tokensPerSecond,
        reporters: config.reporters ?? [],
    };
}

/** The config file that applies to `startDir`: the nearest `jevlint.config.*` in it or a parent directory. */
export function findConfigFile(startDir: string): string | undefined {
    for (let dir = resolve(startDir); ; dir = dirname(dir)) {
        const found = CONFIG_FILE_NAMES.map(name => join(dir, name)).find(candidate => existsSync(candidate));
        if (found) { return found; }
        if (dirname(dir) === dir) { return undefined; }
    }
}

/**
 * Loads `configPath` (relative to `cwd`), or the nearest `jevlint.config.{ts,mts,js,mjs}` found
 * by walking up from `cwd`, and resolves it. TypeScript configs are loaded with jiti.
 */
export async function loadConfig(configPath?: string, cwd: string = process.cwd()): Promise<ResolvedJevlintConfig> {
    const path = configPath ? resolve(cwd, configPath) : findConfigFile(cwd);
    if (!path) { throw new JevlintConfigError(`No jevlint.config.{ts,mts,js,mjs} in ${cwd} or any parent directory. Run \`jevlint init\` to create one, or pass --config <path>.`); }
    if (!existsSync(path)) { throw new JevlintConfigError(`Config file not found: ${path}`); }
    let loaded: unknown;
    try {
        loaded = await createJiti(import.meta.url, { moduleCache: false }).import(path, { default: true });
    } catch (err: unknown) {
        if (err instanceof JevlintConfigError) { throw new JevlintConfigError(`${path}:\n${err.message}`); }
        throw new JevlintConfigError(`Could not load ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!loaded || typeof loaded !== 'object' || !Array.isArray((loaded as JevlintConfig).rules)) { throw new JevlintConfigError(`${path} must default-export a config: \`export default defineConfig({ rules: [...] })\`.`); }
    try {
        return resolveConfig(loaded as JevlintConfig, dirname(path), path);
    } catch (err: unknown) {
        throw err instanceof JevlintConfigError ? new JevlintConfigError(`${path}:\n${err.message}`) : err;
    }
}
