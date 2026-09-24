import type { NoulQuestion } from './types.js';
/**
 * Thin Jev (TypeSafe System One) client: per-question disk cache,
 * token-budgeted batching, bounded concurrency and 429/529 backoff.
 *
 * Three providers carry the same state + questions contract:
 *   gateway   Vercel AI Gateway's documented TypeSafe-compatible endpoint (`/typesafe/v1/systemone`, same
 *             wire format as TypeSafe). It only serves the moving alias (a pinned version is not served),
 *             so thresholds can move under fixtures — `jevlint test --drift` compares against the recorded
 *             calibration. Its rate limit is reached long before the token limit; the client follows
 *             `retry-after` and the `x-ratelimit-*` headers instead of guessing.
 *   typesafe  api.typesafe.ai directly, pinned to a fixed model version.
 *   replay    answers only from the on-disk cache; a miss throws instead of ever reaching the network.
 *             For CI and this package's own tests.
 * The model label is part of every cache and ledger key, so different providers never share answers.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { shardedPath, writeJsonAtomic } from './ledger.js';

/**
 * Where answers come from.
 *
 * - `gateway`: Vercel AI Gateway's TypeSafe-compatible endpoint. Key from `keyEnv` (default `AI_GATEWAY_API_KEY`).
 * - `typesafe`: api.typesafe.ai, pinned to `model`. Key from `keyEnv` (default `TYPESAFE_API_KEY`).
 * - `replay`: answers only from the cache; any miss is an error and nothing is sent. `model` must be the
 *   model label the answers were recorded under (default: the gateway's, `typesafe-ai/jev`).
 *
 * When omitted: `gateway` if `AI_GATEWAY_API_KEY` is set, otherwise `typesafe`.
 */
export type JevlintProviderConfig
    = | { kind: 'gateway'; keyEnv?: string }
        | { kind: 'typesafe'; keyEnv?: string; model?: string }
        | { kind: 'replay'; model?: string };

interface ResolvedProvider { name: 'gateway' | 'typesafe' | 'replay'; model: string; endpoint?: string; keyName?: string; apiKey?: string }

const DEFAULT_GATEWAY_MODEL = 'typesafe-ai/jev';
const DEFAULT_TYPESAFE_MODEL = 'jev-1.13.0';
const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** No API key in the environment variable the provider reads. */
export class JevlintProviderKeyError extends Error {
    constructor(public readonly keyName: string, configured: boolean) {
        super(configured
            ? `${keyName} is not set. Export it in the shell or CI job that runs jevlint (jevlint never reads .env files), or point provider.keyEnv at the variable you use.`
            : `No API key found. Set AI_GATEWAY_API_KEY (Vercel AI Gateway) or TYPESAFE_API_KEY (https://typesafe.ai) in the environment, or set \`provider\` in jevlint.config.ts.`);
        this.name = 'JevlintProviderKeyError';
    }
}

/** The replay provider was asked a question that has no cached answer. */
export class JevlintReplayMissError extends Error {
    constructor(public readonly ids: readonly string[], cacheDir: string, model: string) {
        super(`replay: no cached answer for ${ids.length} question(s) (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''}) under model "${model}" in ${cacheDir}. Replay only returns answers a live provider already gave for the same rule, code and model: run once with a live provider and the same cacheDir, or check provider.model.`);
        this.name = 'JevlintReplayMissError';
    }
}

/** A request to the provider failed for a reason retrying did not fix. */
export class JevlintRequestError extends Error {
    constructor(message: string, public readonly status?: number) {
        super(message);
        this.name = 'JevlintRequestError';
    }
}

/** Resolves a provider config (env reads only — no dotenv, no file reads) into endpoint + key. */
export function resolveProvider(config: JevlintProviderConfig | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
    const provider = config ?? (env.AI_GATEWAY_API_KEY ? { kind: 'gateway' as const } : { kind: 'typesafe' as const });
    if (provider.kind === 'replay') { return { name: 'replay', model: provider.model ?? DEFAULT_GATEWAY_MODEL }; }
    const keyName = provider.keyEnv ?? (provider.kind === 'gateway' ? 'AI_GATEWAY_API_KEY' : 'TYPESAFE_API_KEY');
    const apiKey = env[keyName]?.trim();
    if (!apiKey) { throw new JevlintProviderKeyError(keyName, config !== undefined); }
    return provider.kind === 'gateway'
        ? { name: 'gateway', model: DEFAULT_GATEWAY_MODEL, endpoint: GATEWAY_ENDPOINT, keyName, apiKey }
        : { name: 'typesafe', model: provider.model ?? DEFAULT_TYPESAFE_MODEL, endpoint: TYPESAFE_ENDPOINT, keyName, apiKey };
}

// Hard limits are 64k per request and 32k for state + longest question; stay well inside both.
const REQUEST_TOKEN_BUDGET = 40_000;
const DEFAULT_CONCURRENCY = 48;
const DEFAULT_TOKENS_PER_SECOND = 230_000;
const MAX_ATTEMPTS = 8;
const REQUEST_TIMEOUT_MS = 60_000;

export interface ClientStats { requests: number; inputTokens: number; cacheHits: number; asked: number; throttled: number }

export interface ChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> }
export interface ChoiceAnswer { choice: string; confidence: number; probabilities: Record<string, number> }

export interface JevClient {
    /** Returns P(yes) per question id. Questions are independent and never see each other. */
    ask: (state: unknown, questions: Record<string, NoulQuestion>) => Promise<Record<string, number>>;
    /** One choice question per id; used by the claim verifier. */
    choose: (state: unknown, questions: Record<string, ChoiceQuestion>) => Promise<Record<string, ChoiceAnswer>>;
    stats: ClientStats;
    provider: { name: ResolvedProvider['name']; model: string };
}

/** Rough token estimate; code tokenizes denser than prose, so err on the high side. */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3);
}

/** The per-question disk-cache key: `hash(model, state, question)`. Exported so a test (or a tool that pre-seeds the replay cache) can compute the same path `ask`/`choose` will look up, without duplicating the hash formula. */
export function questionCacheKey(model: string, stateJson: string, question: NoulQuestion | ChoiceQuestion): string {
    return createHash('sha256').update(model).update('\0').update(stateJson).update('\0').update(JSON.stringify(question)).digest('hex');
}

/**
 * Token-rate pacer: each request waits until its estimated tokens fit the per-second budget.
 * The estimate (chars / 3) runs high for code, so it is corrected by the ratio the API reports.
 */
function createTokenPacer(tokensPerSecond: number): { wait: (estimated: number) => Promise<void>; observe: (estimated: number, actual: number) => void } {
    let nextFree = 0;
    let estimatedTotal = 0;
    let actualTotal = 0;
    return {
        async wait(estimated) {
            const ratio = estimatedTotal > 50_000 ? actualTotal / estimatedTotal : 0.7;
            const now = Date.now();
            const start = Math.max(now, nextFree);
            nextFree = start + (estimated * ratio / tokensPerSecond) * 1000;
            if (start > now) { await new Promise(resolve => setTimeout(resolve, start - now)); }
        },
        observe(estimated, actual) {
            estimatedTotal += estimated;
            actualTotal += actual;
        },
    };
}

function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0;
    const waiting: Array<() => void> = [];
    return async (task) => {
        if (active >= max) { await new Promise<void>(resolve => waiting.push(resolve)); }
        active++;
        try {
            return await task();
        } finally {
            active--;
            waiting.shift()?.();
        }
    };
}

interface WireAnswer { type: string; noul?: number; probability?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }
interface WireResponse { answers?: Record<string, WireAnswer>; usage?: { input_tokens?: number; inputTokens?: number } }

export interface JevlintClientOptions {
    cacheDir: string;
    useCache: boolean;
    provider: JevlintProviderConfig | undefined;
    concurrency?: number;
    tokensPerSecond?: number;
    env?: NodeJS.ProcessEnv;
}

function backoff(attempt: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt * (0.5 + Math.random())));
}

function describeNetworkError(err: unknown): string {
    if (err instanceof Error && err.name === 'TimeoutError') { return `no response within ${REQUEST_TIMEOUT_MS / 1000}s`; }
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') { return cause.code; }
    return err instanceof Error ? err.message : String(err);
}

/** Packs questions into requests that stay under the per-request token budget, state included in each. */
function batchByBudget(stateTokens: number, questions: ReadonlyArray<[string, NoulQuestion]>): Array<Record<string, NoulQuestion>> {
    const batches: Array<Record<string, NoulQuestion>> = [];
    let current: Record<string, NoulQuestion> = {};
    let currentTokens = stateTokens;
    for (const [id, question] of questions) {
        const cost = estimateTokens(JSON.stringify(question));
        if (Object.keys(current).length > 0 && currentTokens + cost > REQUEST_TOKEN_BUDGET) {
            batches.push(current);
            current = {};
            currentTokens = stateTokens;
        }
        current[id] = question;
        currentTokens += cost;
    }
    if (Object.keys(current).length > 0) { batches.push(current); }
    return batches;
}

function statusMessage(provider: ResolvedProvider, status: number, attempts: number, body: string): string {
    if (status === 401 || status === 403) { return `${provider.name} rejected the API key in ${provider.keyName} (HTTP ${status}).`; }
    if (status === 429 || status === 529) { return `${provider.name} is still rate limiting after ${attempts} attempts (HTTP ${status}). Lower \`concurrency\` / \`tokensPerSecond\` in the config, or try again later.`; }
    return `${provider.name} answered HTTP ${status}${body ? `: ${body}` : ''}`;
}

export function createJevClient(options: JevlintClientOptions): JevClient {
    const provider = resolveProvider(options.provider, options.env ?? process.env);
    const headers: Record<string, string> = provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' } : {};
    // One gate for every in-flight request: a 429's `retry-after`, or an exhausted request window reported by
    // the rate-limit headers, holds all of them back instead of letting every socket retry into the same wall.
    let blockedUntil = 0;
    const holdFor = (seconds: number): void => {
        blockedUntil = Math.max(blockedUntil, Date.now() + Math.min(seconds, 90) * 1000);
    };
    const limit = createLimiter(options.concurrency ?? DEFAULT_CONCURRENCY);
    const pacer = createTokenPacer(options.tokensPerSecond ?? DEFAULT_TOKENS_PER_SECOND);
    const stats: ClientStats = { requests: 0, inputTokens: 0, cacheHits: 0, asked: 0, throttled: 0 };

    const cachePath = (stateJson: string, question: NoulQuestion | ChoiceQuestion): string => shardedPath(options.cacheDir, 'q', questionCacheKey(provider.model, stateJson, question));

    async function waitForGate(): Promise<void> {
        while (Date.now() < blockedUntil) { await new Promise(resolve => setTimeout(resolve, blockedUntil - Date.now() + Math.random() * 400)); }
    }

    async function waitBeforeRetry(response: Response, attempt: number): Promise<void> {
        if (response.status === 429 || response.status === 529) { stats.throttled++; }
        const retryAfter = Number(response.headers.get('retry-after'));
        // Jitter keeps a burst of throttled requests from returning in lockstep.
        if (Number.isFinite(retryAfter) && retryAfter > 0) { holdFor(retryAfter); } else { await backoff(attempt); }
    }

    /** Window nearly spent: wait for its reset rather than collecting 429s. */
    function observeRateLimit(response: Response): void {
        const remaining = Number(response.headers.get('x-ratelimit-remaining-requests'));
        const reset = Number.parseFloat(response.headers.get('x-ratelimit-reset-requests') ?? '');
        if (Number.isFinite(remaining) && remaining <= (options.concurrency ?? DEFAULT_CONCURRENCY) && Number.isFinite(reset) && reset > 0) { holdFor(reset); }
    }

    /** One HTTP attempt: the parsed answer, or undefined when it should be retried. Throws once retrying cannot help. */
    async function attemptRequest(body: string, attempt: number): Promise<WireResponse | undefined> {
        let response: Response;
        try {
            response = await fetch(provider.endpoint!, { method: 'POST', headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        } catch (err: unknown) {
            if (attempt < MAX_ATTEMPTS) {
                await backoff(attempt);
                return undefined;
            }
            throw new JevlintRequestError(`Could not reach ${provider.name} (${new URL(provider.endpoint!).host}) after ${attempt} attempts: ${describeNetworkError(err)}.`);
        }
        const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
            await waitBeforeRetry(response, attempt);
            return undefined;
        }
        if (!response.ok) { throw new JevlintRequestError(statusMessage(provider, response.status, attempt, (await response.text()).slice(0, 300)), response.status); }
        observeRateLimit(response);
        return await response.json() as WireResponse;
    }

    async function postRaw(stateJson: string, questions: Record<string, NoulQuestion | ChoiceQuestion>): Promise<WireResponse> {
        if (provider.name === 'replay') { throw new JevlintReplayMissError(Object.keys(questions), options.cacheDir, provider.model); }
        const body = `{"model":${JSON.stringify(provider.name === 'gateway' ? 'jev-latest' : provider.model)},"state":${stateJson},"questions":${JSON.stringify(questions)}}`;
        const estimated = estimateTokens(body);
        for (let attempt = 1; ; attempt++) {
            await pacer.wait(estimated);
            await waitForGate();
            const json = await attemptRequest(body, attempt);
            if (!json) { continue; }
            const inputTokens = json.usage?.input_tokens ?? json.usage?.inputTokens ?? 0;
            stats.requests++;
            stats.inputTokens += inputTokens;
            pacer.observe(estimated, inputTokens);
            return json;
        }
    }

    async function post(stateJson: string, questions: Record<string, NoulQuestion>): Promise<Record<string, number>> {
        const json = await postRaw(stateJson, questions);
        const result: Record<string, number> = {};
        for (const id of Object.keys(questions)) {
            const noul = json.answers?.[id]?.noul ?? json.answers?.[id]?.probability;
            if (typeof noul !== 'number') { throw new TypeError(`Jev response is missing a yes/no probability for "${id}".`); }
            result[id] = noul;
        }
        return result;
    }

    /** Splits questions into cached answers and misses. */
    function fromCache<Q extends NoulQuestion | ChoiceQuestion, A>(stateJson: string, questions: Record<string, Q>, read: (stored: unknown) => A): { result: Record<string, A>; misses: Array<[string, Q]> } {
        const result: Record<string, A> = {};
        const misses: Array<[string, Q]> = [];
        for (const [id, question] of Object.entries(questions)) {
            const path = cachePath(stateJson, question);
            if (options.useCache && existsSync(path)) {
                result[id] = read(JSON.parse(readFileSync(path, 'utf-8')));
                stats.cacheHits++;
            } else {
                misses.push([id, question]);
            }
        }
        return { result, misses };
    }

    async function choose(state: unknown, questions: Record<string, ChoiceQuestion>): Promise<Record<string, ChoiceAnswer>> {
        const stateJson = JSON.stringify(state);
        const { result, misses } = fromCache(stateJson, questions, stored => stored as ChoiceAnswer);
        if (misses.length === 0) { return result; }
        const json = await limit(() => postRaw(stateJson, Object.fromEntries(misses)));
        for (const [id, question] of misses) {
            const answer = json.answers?.[id];
            if (!answer?.choice || !answer.probabilities) { throw new Error(`Jev response is missing a choice answer for "${id}".`); }
            const resolved: ChoiceAnswer = { choice: answer.choice, confidence: answer.confidence ?? 0, probabilities: answer.probabilities };
            result[id] = resolved;
            if (options.useCache) { writeJsonAtomic(cachePath(stateJson, question), resolved); }
        }
        return result;
    }

    async function ask(state: unknown, questions: Record<string, NoulQuestion>): Promise<Record<string, number>> {
        const stateJson = JSON.stringify(state);
        const { result, misses } = fromCache(stateJson, questions, stored => (stored as { noul: number }).noul);
        stats.asked += misses.length;
        const batches = batchByBudget(estimateTokens(stateJson), misses);
        const answered = await Promise.all(batches.map(batch => limit(() => post(stateJson, batch))));
        for (const [index, answers] of answered.entries()) {
            for (const [id, noul] of Object.entries(answers)) {
                result[id] = noul;
                const question = batches[index]?.[id];
                if (options.useCache && question) { writeJsonAtomic(cachePath(stateJson, question), { noul }); }
            }
        }
        return result;
    }

    return { ask, choose, stats, provider: { name: provider.name, model: provider.model } };
}
