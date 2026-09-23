/**
 * jevlint rule types — a rule is one audit question compiled into an atomic
 * yes/no question for Jev (TypeSafe System One). "Yes" always means VIOLATION.
 */

export type JevSeverity = 'error' | 'warning';

export interface JevExemption {
    id: string;
    /**
     * `chunk`: the exempting evidence can sit far from the violation (a guard
     * declared far above the flagged line, a lock held for the whole
     * transaction), so the localization window pass must not un-mask it.
     * Default `window`: the evidence is local to the construct, and a
     * neighbouring construct in the same chunk may still violate.
     */
    scope?: 'chunk' | 'window';
    question: string;
    criteria: { true: string; false: string };
}

/**
 * Recall probe: turns real compliant code into a violation, to measure
 * whether a rule actually catches the mistake it targets on real code (not
 * only on hand-written fixtures). `apply` returns the mutated text, or null
 * when the given file has nothing this mutant can mutate.
 */
export interface JevMutant {
    id: string;
    apply: (text: string) => string | null;
}

/**
 * `owned`: the rule is fully graduated — Jev is the reviewer of record for
 * it, with green fixtures, measured recall and triaged real-code precision.
 * `shadow`: still being calibrated; treat a hit as lower-confidence.
 */
export type JevRuleStatus = 'owned' | 'shadow';

/**
 * A second ast-grep rule for evidence that can sit arbitrarily far from a
 * `candidates` match in the same file — a definition used by a call three
 * hundred lines away, a caller of a function the primary rule matched.
 * `linkBy` names a metavariable (no `$`) both rules capture; only a related
 * match whose captured text equals the candidate's own is spliced in as
 * context. Omitting `linkBy` includes every related match in the file, so
 * keep the related rule specific enough that "every match" stays small.
 * Still one construct, one question: the related text is appended as
 * labelled context, capped at `maxLines` (nearest declared line first, a
 * deterministic prefix — never a mid-block truncation).
 */
export interface JevRelatedCandidates {
    /** ast-grep YAML rule body, same DSL as `candidates.rule`. */
    rule: string;
    /** Metavariable name (no `$`) both rules must capture for a related match to be linked. */
    linkBy?: string;
    /** Heading printed above the appended block, e.g. "Definition of the function the loop iterates". */
    label: string;
    contextBefore?: number;
    contextAfter?: number;
    /** Total appended lines across every linked match; default 60. */
    maxLines?: number;
}

export interface JevRule {
    /** Free-form id; recommend `<group>/<name>`. Must be unique in a config. */
    id: string;
    /** Where this rule comes from, printed with every hit — free text (a doc section, a ticket, a team convention). Optional. */
    source?: string;
    severity: JevSeverity;
    status: JevRuleStatus;
    /** The consequence of violating the rule, in one or two sentences. Printed with every hit. */
    why: string;
    /** Repo-relative globs the rule applies to. */
    files: readonly string[];
    exclude?: readonly string[];
    /**
     * Cheap deterministic gate: the question is only asked when the chunk
     * text matches. Keeps tokens down and removes whole classes of false
     * positives (Jev never sees a rule that cannot apply).
     */
    prefilter?: RegExp;
    /** Like `prefilter`, but tested against the whole file: for rules that need a token present somewhere else in a long file. */
    filePrefilter?: RegExp;
    /**
     * Select, then judge: an ast-grep rule (the YAML body of `rule:`) picks
     * the exact constructs, and Jev answers the question once per matched
     * node instead of once per chunk. Use it when several similar
     * constructs share a chunk (one compliant construct must not hide its
     * neighbour) or when the construct is a needle in a long function. The
     * question should talk about "the code in `code`", which is then the
     * matched node preceded by `contextBefore` and followed by
     * `contextAfter` lines. `rule` is the body of an ast-grep YAML rule
     * (what follows `rule:`), run in-process on `.ts`/`.mts`/`.cts`/`.tsx`
     * files and on the `<script>` block of `.vue` files. Single-node
     * metavariables it binds (`$NAME`) are available to `related.linkBy`.
     */
    candidates?: { rule: string; contextBefore?: number; contextAfter?: number; related?: JevRelatedCandidates };
    /**
     * Negative gate: the rule is not asked about text this matches. For "X
     * is missing" rules whose marker is exact, this decides the compliant
     * case in code, for free.
     */
    unless?: RegExp;
    /**
     * Judge the whole file instead of per chunk. Required for "X is
     * missing" rules: a chunk that does not contain the guard would look
     * like a violation.
     */
    wholeFile?: boolean;
    /** Atomic English question about the code in `code`; phrased so yes = violation. */
    question: string;
    criteria: { true: string; false: string };
    /**
     * Legitimate exceptions, each asked as its own question in the same
     * request (yes = the exception applies). A hit is suppressed when any
     * exemption answers >= 0.5. Keeping them out of `criteria.false` leaves
     * the violation judgment at full strength and makes every suppression
     * visible in the report.
     */
    exemptions?: readonly JevExemption[];
    /**
     * The rule is decidable by AST / regex / file layout and is only here
     * as stopgap coverage until a deterministic linter implements it.
     * Listed by `jevlint list`.
     */
    deterministicCandidate?: string;
    /**
     * Deterministic edit of the chunk text before it is sent (see
     * `jevlint/prepare`). Must keep the line count. Rules sharing a chunk
     * but not a `prepare` are asked in separate requests.
     */
    prepare?: (text: string) => string;
    mutants?: readonly JevMutant[];
    /** Probability at or above which a hit is reported. Default 0.8. */
    threshold?: number;
    /**
     * What the file cannot show and a reviewer must check elsewhere before
     * acting on a hit. Printed with every hit.
     */
    confirm?: string;
    /** What a fixer should do; printed with the hit. */
    fix: string;
}

export interface Chunk {
    file: string;
    /** 1-based inclusive line range inside the file. */
    startLine: number;
    endLine: number;
    /** Text sent as state: file header (imports) + the chunk body when the file was split. */
    text: string;
}

export interface JevVerdict {
    rule: JevRule;
    chunk: Chunk;
    probability: number;
    /** Exemption answers for this chunk; any value >= 0.5 suppresses the hit. */
    exemptions: Record<string, number>;
    /** Narrowed range from the localization pass, when it produced a confident answer. */
    located?: { startLine: number; endLine: number; probability: number };
}

export interface NoulQuestion {
    type: 'noul';
    instructions: string;
    criteria: { true: string; false: string };
}

/**
 * Identity helper for authoring a rule with full type checking and
 * autocomplete — the same pattern as `defineConfig` in other tools. Returns
 * `rule` unchanged.
 */
export function defineRule(rule: JevRule): JevRule {
    return rule;
}
