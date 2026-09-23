/**
 * In-process ast-grep for `candidates` rules. A rule body is ast-grep's
 * YAML rule DSL (the value of `rule:` in an ast-grep rule file); it is
 * parsed and compiled once, then run against source text with
 * `@ast-grep/napi`. No binary, no temp files.
 */
import type { NapiConfig, SgNode } from '@ast-grep/napi';
import { Lang, parse } from '@ast-grep/napi';
import { parse as parseYaml } from 'yaml';

/** One matched node: 1-based inclusive line span plus the text of every single-node metavariable it bound. */
export interface AstGrepMatch { startLine: number; endLine: number; meta: Record<string, string> }

export type AstGrepLanguage = 'typescript' | 'tsx';

interface CompiledRule { config: NapiConfig; metaVariables: readonly string[] }

const compiled = new Map<string, CompiledRule>();

// `$NAME` and `$$NAME` bind a single node; `$$$NAME` binds a list and `$_NAME` binds nothing.
const SINGLE_META_VARIABLE = /(?<!\$)\${1,2}([A-Z][A-Z0-9_]*)/g;

export class AstGrepRuleError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AstGrepRuleError';
    }
}

function compile(ruleYaml: string): CompiledRule {
    const cached = compiled.get(ruleYaml);
    if (cached) { return cached; }
    let rule: unknown;
    try {
        rule = parseYaml(ruleYaml);
    } catch (err: unknown) {
        throw new AstGrepRuleError(`not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { throw new AstGrepRuleError('must be a YAML mapping (the body of an ast-grep `rule:`), e.g. "pattern: foo($A)"'); }
    const metaVariables = [...new Set([...ruleYaml.matchAll(SINGLE_META_VARIABLE)].map(match => match[1]!))];
    const entry: CompiledRule = { config: { rule: rule as NapiConfig['rule'] }, metaVariables };
    try {
        // ast-grep validates a rule lazily; run it once on empty input so a bad rule fails here, not mid-scan.
        parse(Lang.TypeScript, '').root().findAll(entry.config);
    } catch (err: unknown) {
        throw new AstGrepRuleError(err instanceof Error ? err.message : String(err));
    }
    compiled.set(ruleYaml, entry);
    return entry;
}

/** Throws `AstGrepRuleError` when `ruleYaml` is not a usable ast-grep rule body. */
export function validateAstGrepRule(ruleYaml: string): void {
    compile(ruleYaml);
}

function toMatch(node: SgNode, metaVariables: readonly string[]): AstGrepMatch {
    const { start, end } = node.range();
    const meta: Record<string, string> = {};
    for (const name of metaVariables) {
        const bound = node.getMatch(name);
        if (bound) { meta[name] = bound.text(); }
    }
    return { startLine: start.line + 1, endLine: end.line + 1, meta };
}

/** Every node in `text` the rule matches, in document order. */
export function findAstMatches(ruleYaml: string, text: string, language: AstGrepLanguage): AstGrepMatch[] {
    const { config, metaVariables } = compile(ruleYaml);
    const root = parse(language === 'tsx' ? Lang.Tsx : Lang.TypeScript, text).root();
    return root.findAll(config).map(node => toMatch(node, metaVariables));
}
