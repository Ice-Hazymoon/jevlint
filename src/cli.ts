import type { RecallMutantResult, TestResult } from './api.js';
import type { ResolvedJevcheckConfig } from './config.js';
import type { LintRunResult } from './reporters.js';
import type { JevRule } from './types.js';
import type { Claim } from './verify.js';
/**
 * The `jevcheck` command line: argument parsing, file selection and output. Every command is a thin
 * layer over the programmatic API in `api.ts`.
 */
/* eslint-disable no-console -- a CLI's output is console output */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createJevcheck } from './api.js';
import { matchesGlobs } from './candidates.js';
import { findConfigFile, loadConfig } from './config.js';
import { createStyle, formatStylish } from './reporters.js';

interface OptionSpec { name: string; value?: string; help: string }
interface CommandSpec { usage: string; summary: string; details?: string; options: readonly OptionSpec[] }

const RULES: OptionSpec = { name: 'rules', value: 'ids', help: 'only these rule ids or id prefixes, comma-separated (e.g. "security/,logging/no-secret-in-log")' };
const OWNED: OptionSpec = { name: 'owned', help: 'only rules with status "owned"' };
const SCOPE: readonly OptionSpec[] = [
    { name: 'changed', help: 'files changed in the working tree since HEAD, plus untracked files' },
    { name: 'staged', help: 'files in the git index' },
    { name: 'base', value: 'ref', help: 'files changed since <ref> (merge base), plus the working tree' },
];

const COMMANDS: Record<string, CommandSpec> = {
    scan: {
        usage: 'jevcheck [paths...] [options]',
        summary: 'Scan files and directories (default: the current directory).',
        details: 'Applies the baseline file to every scan, so only new hits are reported. Use --no-baseline to see everything.',
        options: [
            ...SCOPE,
            RULES,
            OWNED,
            { name: 'format', value: 'name', help: 'stylish (default), json or sarif' },
            { name: 'no-baseline', help: 'never apply the baseline' },
            { name: 'no-cache', help: 'ask again instead of using cached answers' },
            { name: 'no-locate', help: 'skip the pass that narrows a chunk-level hit to a smaller line range' },
            { name: 'no-prefilter', help: 'ignore prefilter/unless gates, to find violations a gate hides' },
            { name: 'review', help: 'also show near-threshold (0.5+) and exempted verdicts' },
        ],
    },
    test: {
        usage: 'jevcheck test [options]',
        summary: 'Run every rule against its fixtures.',
        details: 'Fixtures live in <fixtures>/<rule id with "/" as "__">/ and are named invalid-*.txt (must fire), valid-*.txt (must not) or exempt-*.txt (an exemption must apply). The first line of each is "// path: <file path the snippet pretends to be at>".',
        options: [
            RULES,
            { name: 'record', help: 'save the fixture probabilities to the calibration file' },
            { name: 'drift', help: 'ask again without the cache and compare with the calibration file' },
        ],
    },
    recall: {
        usage: 'jevcheck recall [options]',
        summary: 'Inject violations into real files with each rule\'s mutants and count how many are caught.',
        options: [
            RULES,
            { name: 'sample', value: 'n', help: 'files judged per mutant (default 12)' },
            { name: 'dry', help: 'list the files each mutant can mutate; ask nothing' },
        ],
    },
    baseline: {
        usage: 'jevcheck baseline [paths...] [options]',
        summary: 'Record the current hits as accepted, so later scans report only new ones.',
        details: 'A plain scan (baseline applied by default) then reports only hits not in the baseline.',
        options: [...SCOPE, RULES, OWNED],
    },
    list: {
        usage: 'jevcheck list [options]',
        summary: 'List the configured rules.',
        options: [RULES, OWNED],
    },
    verify: {
        usage: 'jevcheck verify <claims.json> [options]',
        summary: 'Check statements about code against the lines they cite.',
        details: 'claims.json is an array of { "id", "file", "startLine"?, "endLine"?, "claim", "quote"? }. Each claim is reported as verified, contradicted, unsupported, review, fabricated (missing file, range or quote) or invalid.',
        options: [{ name: 'format', value: 'name', help: 'text (default) or json' }],
    },
    cache: {
        usage: 'jevcheck cache prune [options]',
        summary: 'Delete cache entries that were not used recently.',
        options: [{ name: 'max-age-days', value: 'n', help: 'keep entries used within this many days (default 30)' }],
    },
    hook: {
        usage: 'jevcheck hook',
        summary: 'Post-edit hook for coding agents and editors: judge one edited file with the owned rules.',
        details: 'Reads a JSON object from stdin carrying the edited file\'s path as "file_path", "path" or "file", at the top level or under "tool_input" / "input". Exits 2 with the hits on stderr when an owned rule fires, 0 otherwise. Its own failures are printed on stderr but never block the edit (exit 0).',
        options: [],
    },
    init: {
        usage: 'jevcheck init',
        summary: 'Create jevcheck.config.ts with an example rule and its fixtures in the current directory.',
        options: [],
    },
};

const GLOBAL_OPTIONS: readonly OptionSpec[] = [
    { name: 'config', value: 'path', help: 'config file (default: nearest jevcheck.config.{ts,mts,js,mjs} upward from the current directory)' },
    { name: 'help', help: 'show help' },
];

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;

/** A command-line mistake: printed with a pointer to the right `--help`, exit code 2. */
export class UsageError extends Error {
    constructor(message: string, public readonly command: string) {
        super(message);
        this.name = 'UsageError';
    }
}

export interface ParsedArgs { command: string; flags: ReadonlySet<string>; values: ReadonlyMap<string, string>; positionals: readonly string[] }

/** Reads one `--name`, `--name=value` or `--name value` token; returns how many tokens it used. */
function readOption(tokens: readonly string[], index: number, spec: readonly OptionSpec[], command: string): { name: string; value?: string; used: number } {
    const token = tokens[index]!;
    const equals = token.indexOf('=');
    const name = token.startsWith('--') ? token.slice(2, equals === -1 ? undefined : equals) : token;
    const inline = token.startsWith('--') && equals !== -1 ? token.slice(equals + 1) : undefined;
    const option = spec.find(item => item.name === name);
    if (!option) { throw new UsageError(`unknown option '${token}'`, command); }
    if (!option.value) {
        if (inline !== undefined) { throw new UsageError(`option '--${name}' does not take a value`, command); }
        return { name, used: 1 };
    }
    const value = inline ?? tokens[index + 1];
    const missing = value === undefined || value === '' || (inline === undefined && value.startsWith('--'));
    if (missing) { throw new UsageError(`option '--${name}' needs a value <${option.value}>`, command); }
    return { name, value, used: inline === undefined ? 2 : 1 };
}

/** Splits argv into a command, its flags, option values and positionals. Commands come first, like git. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
    const first = argv[0];
    const command = first && first !== 'scan' && Object.hasOwn(COMMANDS, first) ? first : 'scan';
    const rest = command === 'scan' ? argv : argv.slice(1);
    const spec = [...COMMANDS[command]!.options, ...GLOBAL_OPTIONS];
    const split = rest.indexOf('--');
    const tokens = (split === -1 ? rest : rest.slice(0, split)).map(token => (token === '-h' ? '--help' : token));
    const flags = new Set<string>();
    const values = new Map<string, string>();
    const positionals: string[] = [];
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (!token.startsWith('-') || token === '-') {
            positionals.push(token);
            index++;
            continue;
        }
        const option = readOption(tokens, index, spec, command);
        if (option.value === undefined) { flags.add(option.name); } else { values.set(option.name, option.value); }
        index += option.used;
    }
    return { command, flags, values, positionals: [...positionals, ...(split === -1 ? [] : rest.slice(split + 1))] };
}

/** Help text for one command, or the overview for `scan`. */
export function helpText(command: string): string {
    const spec = COMMANDS[command]!;
    const optionLines = (options: readonly OptionSpec[]): string[] => options.map((option) => {
        const left = `--${option.name}${option.value ? ` <${option.value}>` : ''}`;
        return `  ${left.padEnd(22)} ${option.help}`;
    });
    const wrap = (text: string): string => text.split(' ').reduce<string[]>((lines, word) => {
        const last = lines.at(-1);
        if (last !== undefined && last.length + word.length < 88) { lines[lines.length - 1] = `${last} ${word}`; } else { lines.push(word); }
        return lines;
    }, []).join('\n');
    const lines = [`Usage: ${spec.usage}`, '', spec.summary];
    if (spec.details) { lines.push('', wrap(spec.details)); }
    if (command === 'scan') {
        lines.push('', 'Commands:');
        for (const [name, other] of Object.entries(COMMANDS).filter(([name]) => name !== 'scan')) { lines.push(`  ${(name === 'cache' ? 'cache prune' : name).padEnd(22)} ${other.summary}`); }
        lines.push('', 'Run "jevcheck <command> --help" for a command\'s options.');
    }
    if (spec.options.length > 0) { lines.push('', 'Options:', ...optionLines(spec.options)); }
    lines.push('', 'Global options:', ...optionLines(GLOBAL_OPTIONS));
    if (command === 'scan') { lines.push('  --version              print the version', '', 'Exit codes: 0 no error-severity hit, 1 at least one error-severity hit, 2 usage or runtime error.'); }
    return lines.join('\n');
}

function ruleIds(args: ParsedArgs): string[] | undefined {
    return args.values.get('rules')?.split(',').map(id => id.trim()).filter(Boolean);
}

function positiveInteger(args: ParsedArgs, name: string, fallback: number): number {
    const raw = args.values.get(name);
    if (raw === undefined) { return fallback; }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) { throw new UsageError(`option '--${name}' needs a whole number, got '${raw}'`, args.command); }
    return value;
}

function walk(path: string, out: string[]): void {
    if (!statSync(path).isDirectory()) {
        out.push(path);
        return;
    }
    for (const entry of readdirSync(path)) {
        if (entry !== 'node_modules' && entry !== '.git') { walk(join(path, entry), out); }
    }
}

function git(config: ResolvedJevcheckConfig, args: readonly string[]): string[] {
    try {
        return execFileSync('git', args, { cwd: config.root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
    } catch (err: unknown) {
        const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
        if (/not a git repository/i.test(stderr)) { throw new Error(`${config.root} is not in a git repository; --changed, --staged and --base need one.`); }
        if ((err as { code?: unknown }).code === 'ENOENT') { throw new Error('git is not installed or not on PATH.'); }
        throw new Error(`git ${args.join(' ')} failed: ${stderr.split('\n').at(-1) ?? ''}`);
    }
}

/** The files a scan or baseline run covers, relative to the config root, filtered by `include` / `ignore`. */
function collectFiles(args: ParsedArgs, config: ResolvedJevcheckConfig): string[] {
    const files: string[] = [];
    const base = args.values.get('base');
    if (args.flags.has('changed')) { files.push(...git(config, ['diff', '--name-only', '--diff-filter=d', 'HEAD']), ...git(config, ['ls-files', '--others', '--exclude-standard'])); }
    if (args.flags.has('staged')) { files.push(...git(config, ['diff', '--name-only', '--diff-filter=d', '--cached'])); }
    if (base) { files.push(...git(config, ['diff', '--name-only', '--diff-filter=d', `${base}...HEAD`]), ...git(config, ['diff', '--name-only', '--diff-filter=d', 'HEAD'])); }
    const gitScope = args.flags.has('changed') || args.flags.has('staged') || base !== undefined;
    const paths = args.positionals.length > 0 || gitScope ? args.positionals : ['.'];
    for (const path of paths) {
        const absolute = resolve(process.cwd(), path);
        if (!existsSync(absolute)) { throw new UsageError(/^[a-z-]+$/.test(path) ? `'${path}' is neither a command nor an existing path` : `no such file or directory: ${path}`, args.command); }
        const found: string[] = [];
        walk(absolute, found);
        files.push(...found.map(file => relative(config.root, file)));
    }
    return [...new Set(files.map(file => file.split(sep).join('/')))]
        .filter(file => !file.startsWith('../') && matchesGlobs(config.include, file) && !matchesGlobs(config.ignore, file) && existsSync(join(config.root, file)))
        .sort();
}

function toSarif(result: LintRunResult, rules: readonly JevRule[]): unknown {
    const used = [...new Set(result.hits.map(hit => hit.rule))];
    const byId = new Map(rules.map(rule => [rule.id, rule]));
    return {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [{
            tool: {
                driver: {
                    name: 'jevcheck',
                    version: VERSION,
                    informationUri: 'https://github.com/Ice-Hazymoon/jevcheck',
                    rules: used.map((id) => {
                        const rule = byId.get(id)!;
                        return { id, name: id, shortDescription: { text: rule.why }, help: { text: rule.fix }, defaultConfiguration: { level: rule.severity } };
                    }),
                },
            },
            results: result.hits.map(hit => ({
                ruleId: hit.rule,
                ruleIndex: used.indexOf(hit.rule),
                level: hit.severity,
                message: { text: `${hit.why} Fix: ${hit.fix}${hit.confirm ? ` Confirm first: ${hit.confirm}` : ''}` },
                locations: [{ physicalLocation: { artifactLocation: { uri: hit.file, uriBaseId: '%SRCROOT%' }, region: { startLine: hit.startLine, endLine: hit.endLine } } }],
                properties: { probability: hit.probability },
            })),
        }],
    };
}

async function runScan(args: ParsedArgs, config: ResolvedJevcheckConfig): Promise<number> {
    const format = args.values.get('format') ?? 'stylish';
    if (!['stylish', 'json', 'sarif'].includes(format)) { throw new UsageError(`--format must be stylish, json or sarif, got '${format}'`, 'scan'); }
    const files = collectFiles(args, config);
    const result = await createJevcheck({ ...config, reporters: [] }).lint(files, {
        rules: ruleIds(args),
        owned: args.flags.has('owned'),
        useBaseline: !args.flags.has('no-baseline'),
        noCache: args.flags.has('no-cache'),
        noLocate: args.flags.has('no-locate'),
        noPrefilter: args.flags.has('no-prefilter'),
        review: args.flags.has('review'),
    });
    if (format === 'json') {
        console.log(JSON.stringify(result, null, 2));
    } else if (format === 'sarif') {
        console.log(JSON.stringify(toSarif(result, config.rules), null, 2));
    } else if (files.length === 0) {
        console.log('No files to scan: nothing selected matches the config\'s include/ignore globs.');
    } else {
        console.log(formatStylish(result, { showExempted: args.flags.has('review') }));
    }
    for (const reporter of config.reporters) { await reporter.onRunComplete(result); }
    return result.hits.some(hit => hit.severity === 'error') ? 1 : 0;
}

function printTestResult(result: TestResult, config: ResolvedJevcheckConfig): boolean {
    const style = createStyle();
    const width = Math.min(70, Math.max(0, ...result.cases.map(c => c.key.length)));
    for (const c of result.cases) { console.log(`${c.ok ? style.green('pass') : style.red('FAIL')}  ${c.key.padEnd(width)}  ${style.dim(c.detail)}${c.thinMargin ? style.yellow('  thin margin') : ''}`); }
    if (result.thin.length > 0) { console.log(`\n${result.thin.length} fixture(s) pass by less than 0.05. Sharpen the question or the fixture before the model moves.`); }
    if (result.missingFixtures.length > 0) { console.log(`\n${style.red(`${result.missingFixtures.length} rule(s) need at least one invalid-*.txt and one valid-*.txt fixture`)} in ${relative(process.cwd(), config.fixtures) || '.'}:\n  ${result.missingFixtures.join('\n  ')}`); }
    if (result.recorded) { console.log(`\nRecorded ${result.recorded.fixtureAnswers} fixture probabilities (${result.recorded.totalAnswers} in total) to ${relative(process.cwd(), config.calibration)}.`); }
    if (result.drift) { console.log([`\nDrift: mean |Δp| ${result.drift.meanAbsoluteDelta.toFixed(3)}; ${result.drift.moved.length} fixture(s) moved by 0.10 or more`, ...result.drift.moved.slice(0, 25).map(item => `  ${item.key.padEnd(width)}  ${item.before.toFixed(2)} → ${item.after.toFixed(2)}`)].join('\n')); }
    const failed = result.failures > 0 || result.missingFixtures.length > 0;
    const verdict = failed ? style.red(`✖ ${result.failures} of ${result.cases.length} fixture(s) failed`) : style.green(`✔ ${result.cases.length} fixture(s) passed`);
    console.log(`\n${verdict}${style.dim(` · ${result.requests} request(s), ${result.inputTokens} input tokens`)}`);
    return failed;
}

async function runTest(args: ParsedArgs, config: ResolvedJevcheckConfig): Promise<number> {
    const result = await createJevcheck(config).test({ rules: ruleIds(args), record: args.flags.has('record'), drift: args.flags.has('drift') });
    return printTestResult(result, config) ? 1 : 0;
}

function trackedFiles(config: ResolvedJevcheckConfig): string[] {
    try {
        return git(config, ['ls-files']);
    } catch {
        const found: string[] = [];
        walk(config.root, found);
        return found.map(file => relative(config.root, file).split(sep).join('/'));
    }
}

function mutantLines(m: RecallMutantResult, dry: boolean, style: ReturnType<typeof createStyle>): string[] {
    const head = `${m.rule}  ${style.dim(m.mutant)}`;
    if (dry) { return [`${head}: ${m.candidateCount} mutable file(s)`, ...m.misses.map(file => `    ${file}`)]; }
    if (m.recall === undefined) { return [`${head}  ${style.dim('no mutable file')}`]; }
    const rate = `${m.caught}/${m.judged}  recall=${m.recall.toFixed(2)}`;
    return [`${head}  ${(m.graduates ? style.green : style.yellow)(rate)}`, ...m.misses.map(miss => `    missed: ${miss}`), ...m.invalidMutants.map(item => `    invalid mutant: ${item}`)];
}

async function runRecall(args: ParsedArgs, config: ResolvedJevcheckConfig): Promise<number> {
    const style = createStyle();
    const dry = args.flags.has('dry');
    const result = await createJevcheck(config).recall({ rules: ruleIds(args), files: trackedFiles(config), sampleSize: positiveInteger(args, 'sample', 12), dry });
    if (result.mutants.length === 0) {
        console.log('No selected rule declares mutants, so there is nothing to measure.');
        return 0;
    }
    console.log(result.mutants.flatMap(m => mutantLines(m, dry, style)).join('\n'));
    if (dry) { return 0; }
    console.log(`\nWeakest recall ${result.weakestRecall.toFixed(2)}${style.dim(` · ${result.requests} request(s), ${result.inputTokens} input tokens`)}`);
    return result.weakestRecall < 0.9 ? 1 : 0;
}

async function runBaseline(args: ParsedArgs, config: ResolvedJevcheckConfig): Promise<number> {
    const files = collectFiles(args, config);
    const { hitsWritten, totalEntries } = await createJevcheck(config).baseline(files, { rules: ruleIds(args), owned: args.flags.has('owned') });
    console.log(`Accepted ${hitsWritten} hit(s) from ${files.length} file(s); ${relative(process.cwd(), config.baseline)} now has ${totalEntries} entr${totalEntries === 1 ? 'y' : 'ies'}.`);
    return 0;
}

function runList(args: ParsedArgs, config: ResolvedJevcheckConfig): number {
    const style = createStyle();
    const rules = createJevcheck(config).listRules({ rules: ruleIds(args), owned: args.flags.has('owned') });
    const width = Math.max(0, ...rules.map(rule => rule.id.length));
    for (const rule of rules) {
        const notes = [rule.source, rule.deterministicCandidate ? `deterministic candidate: ${rule.deterministicCandidate}` : ''].filter(Boolean).join(' · ');
        const line = `${rule.id.padEnd(width)}  ${rule.status.padEnd(6)}  ${rule.severity.padEnd(7)}`;
        console.log(notes ? `${line}  ${style.dim(notes)}` : line);
    }
    console.log(style.dim(`\n${rules.length} rule(s)`));
    return 0;
}

function parseClaims(path: string): Claim[] {
    const parsed: unknown = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf-8'));
    if (!Array.isArray(parsed)) { throw new UsageError(`${path} must contain a JSON array of claims`, 'verify'); }
    return parsed.map((item: unknown, index) => {
        const entry = (item ?? {}) as Record<string, unknown>;
        if (typeof entry.file !== 'string' || typeof entry.claim !== 'string') { throw new UsageError(`claim #${index + 1} needs string "file" and "claim"`, 'verify'); }
        const text = (key: string): string | undefined => (typeof entry[key] === 'string' ? entry[key] : undefined);
        const line = (key: string): number | undefined => (typeof entry[key] === 'number' ? entry[key] : undefined);
        return { id: text('id') ?? `#${index + 1}`, file: entry.file, claim: entry.claim, startLine: line('startLine'), endLine: line('endLine'), quote: text('quote') };
    });
}

async function runVerify(args: ParsedArgs, config: ResolvedJevcheckConfig): Promise<number> {
    const [path, ...extra] = args.positionals;
    if (!path || extra.length > 0) { throw new UsageError('verify needs exactly one claims file', 'verify'); }
    const format = args.values.get('format') ?? 'text';
    if (format !== 'text' && format !== 'json') { throw new UsageError(`--format must be text or json, got '${format}'`, 'verify'); }
    const { verdicts, requests, inputTokens } = await createJevcheck(config).verify(parseClaims(path));
    const verified = verdicts.filter(item => item.verdict === 'verified').length;
    if (format === 'json') {
        console.log(JSON.stringify(verdicts, null, 2));
    } else {
        const width = Math.max(0, ...verdicts.map(item => item.id.length));
        console.log([...verdicts.map(item => `${item.verdict.padEnd(12)} ${item.id.padEnd(width)}  ${item.detail}`), '', `${verified}/${verdicts.length} verified · ${requests} request(s), ${inputTokens} input tokens`].join('\n'));
    }
    return verified === verdicts.length ? 0 : 1;
}

function runCache(args: ParsedArgs, config: ResolvedJevcheckConfig): number {
    if (args.positionals[0] !== 'prune' || args.positionals.length > 1) { throw new UsageError('the only cache command is "jevcheck cache prune"', 'cache'); }
    const { removed, kept } = createJevcheck(config).pruneCache(positiveInteger(args, 'max-age-days', 30));
    console.log(`${config.cacheDir}: removed ${removed} entr${removed === 1 ? 'y' : 'ies'}, kept ${kept}.`);
    return 0;
}

/** The edited file's path from a post-edit hook payload, wherever the calling tool puts it. */
export function hookFilePath(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') { return undefined; }
    const record = payload as Record<string, unknown>;
    for (const holder of [record, record.tool_input, record.input]) {
        if (!holder || typeof holder !== 'object') { continue; }
        const value = ['file_path', 'path', 'file'].map(key => (holder as Record<string, unknown>)[key]).find(item => typeof item === 'string' && item.length > 0);
        if (typeof value === 'string') { return value; }
    }
    return undefined;
}

async function runHook(configPath: string | undefined): Promise<number> {
    try {
        const config = await loadConfig(configPath);
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) { chunks.push(chunk as Buffer); }
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
        const path = hookFilePath(payload);
        if (!path) { return 0; }
        const cwd = typeof (payload as { cwd?: unknown }).cwd === 'string' ? (payload as { cwd: string }).cwd : process.cwd();
        const file = relative(config.root, resolve(cwd, path)).split(sep).join('/');
        if (file.startsWith('../') || !matchesGlobs(config.include, file) || matchesGlobs(config.ignore, file) || !existsSync(join(config.root, file))) { return 0; }
        const result = await createJevcheck(config).lint([file], { owned: true, useBaseline: true });
        if (result.hits.length === 0) { return 0; }
        const report = result.hits.map(hit => `${hit.file}:${hit.startLine}-${hit.endLine} ${hit.rule} (p=${hit.probability.toFixed(2)})\n  why: ${hit.why}\n  fix: ${hit.fix}${hit.confirm ? `\n  confirm first: ${hit.confirm}` : ''}`).join('\n');
        console.error(`jevcheck: ${result.hits.length} rule hit(s) in the file just edited. Check each against the code, then fix it or say why it does not apply.\n${report}`);
        return 2;
    } catch (err: unknown) {
        console.error(`jevcheck hook: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
    }
}

const EXAMPLE_CONFIG = `import { defineConfig, defineRule } from 'jevcheck';

// A rule is one yes/no question about a piece of code; "yes" means a violation.
const noSecretInLog = defineRule({
    id: 'example/no-secret-in-log',
    severity: 'error',
    // "owned": trusted and used by \`jevcheck hook\`. Use "shadow" while a rule is still being tuned.
    status: 'owned',
    why: 'Secrets written to logs spread to log storage, alerts and backups, which are much harder to purge than code.',
    files: ['**/*.{ts,tsx,mts,vue}'],
    // Cheap regex gate: only code that contains a logging call is sent to the model.
    prefilter: /\\b(?:console|logger|log)\\.(?:log|info|warn|error|debug)\\s*\\(/,
    question: 'Does the code in \`code\` pass a password, API key, access token or other secret value to a logging call?',
    criteria: {
        true: 'A logging call receives a variable, property or literal that holds a password, API key, token, private key or similar credential.',
        false: 'Logging calls only receive identifiers, counts, statuses, messages or values that are already redacted.',
    },
    fix: 'Remove the secret from the logging call, or log a redacted form of it.',
});

export default defineConfig({
    rules: [noSecretInLog],
    // Everything else has a default. See https://github.com/Ice-Hazymoon/jevcheck#configuration
});
`;

const EXAMPLE_FIXTURES: Record<string, string> = {
    'invalid-password-logged.txt': `// path: src/auth/login.ts
export async function login(email: string, password: string): Promise<Session> {
    logger.info('login attempt', { email, password });
    return authenticate(email, password);
}
`,
    'valid-identifier-logged.txt': `// path: src/auth/login.ts
export async function login(email: string, password: string): Promise<Session> {
    logger.info('login attempt', { email });
    return authenticate(email, password);
}
`,
};

function runInit(): number {
    const cwd = process.cwd();
    const existing = findConfigFile(cwd);
    if (existing && dirname(existing) === cwd) { throw new UsageError(`${relative(cwd, existing)} already exists; not overwriting it`, 'init'); }
    const written: string[] = [];
    const write = (path: string, content: string): void => {
        if (existsSync(path)) { return; }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        written.push(relative(cwd, path));
    };
    write(join(cwd, 'jevcheck.config.ts'), EXAMPLE_CONFIG);
    for (const [name, content] of Object.entries(EXAMPLE_FIXTURES)) { write(join(cwd, 'jevcheck/fixtures/example__no-secret-in-log', name), content); }
    console.log(`Created:\n  ${written.join('\n  ')}\n
Next:
  1. Export an API key: AI_GATEWAY_API_KEY (Vercel AI Gateway) or TYPESAFE_API_KEY (TypeSafe).
  2. npx jevcheck test    check the example rule against its two fixtures
  3. npx jevcheck         scan this directory`);
    return 0;
}

const HANDLERS: Record<string, (args: ParsedArgs, config: ResolvedJevcheckConfig) => number | Promise<number>> = {
    scan: runScan,
    test: runTest,
    recall: runRecall,
    baseline: runBaseline,
    list: runList,
    verify: runVerify,
    cache: runCache,
};
const TAKES_POSITIONALS = new Set(['scan', 'baseline', 'verify', 'cache']);

function reportError(err: unknown): number {
    if (err instanceof UsageError) {
        console.error(`jevcheck: ${err.message}\nRun "jevcheck${err.command === 'scan' ? '' : ` ${err.command}`} --help" for usage.`);
    } else {
        console.error(`jevcheck: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 2;
}

/** Runs the CLI with `argv` (without the node and script paths); resolves to the exit code. */
export async function run(argv: readonly string[]): Promise<number> {
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
        console.log(VERSION);
        return 0;
    }
    try {
        const args = parseArgs(argv);
        if (args.flags.has('help')) {
            console.log(helpText(args.command));
            return 0;
        }
        if (args.command === 'init') { return runInit(); }
        if (args.command === 'hook') { return await runHook(args.values.get('config')); }
        if (!TAKES_POSITIONALS.has(args.command) && args.positionals.length > 0) { throw new UsageError(`unexpected argument '${args.positionals[0]}'`, args.command); }
        const config = await loadConfig(args.values.get('config'));
        return await HANDLERS[args.command]!(args, config);
    } catch (err: unknown) {
        return reportError(err);
    }
}
