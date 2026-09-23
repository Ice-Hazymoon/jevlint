import type { NoulQuestion } from '../src/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJevClient, JevlintProviderKeyError, JevlintReplayMissError, JevlintRequestError, questionCacheKey, resolveProvider } from '../src/client.js';
import { shardedPath, writeJsonAtomic } from '../src/ledger.js';

// The whole point of the replay provider: these tests never touch the network, and never need an API key.
describe('replay provider', () => {
    let cacheDir: string;

    beforeEach(() => {
        cacheDir = mkdtempSync(join(tmpdir(), 'jevlint-replay-test-'));
    });
    afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

    it('answers from a pre-seeded cache entry with zero requests', async () => {
        const state = { file: 'src/a.ts', code: 'console.log(1);' };
        const stateJson = JSON.stringify(state);
        const question: NoulQuestion = { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } };
        // Replay reads answers recorded under the gateway's model label unless told otherwise.
        const key = questionCacheKey('typesafe-ai/jev', stateJson, question);
        writeJsonAtomic(shardedPath(cacheDir, 'q', key), { noul: 0.93 });

        const client = createJevClient({ cacheDir, useCache: true, provider: { kind: 'replay' } });
        const answers = await client.ask(state, { 'demo/rule': question });
        expect(answers['demo/rule']).toBe(0.93);
        expect(client.stats.requests).toBe(0);
        expect(client.stats.cacheHits).toBe(1);
    });

    it('fails loud — never silently returns a fabricated answer — on a cache miss', async () => {
        const client = createJevClient({ cacheDir, useCache: true, provider: { kind: 'replay' } });
        const question: NoulQuestion = { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } };
        await expect(client.ask({ file: 'src/a.ts', code: 'x' }, { 'demo/rule': question })).rejects.toThrow(JevlintReplayMissError);
        await expect(client.ask({ file: 'src/a.ts', code: 'x' }, { 'demo/rule': question })).rejects.toThrow(/demo\/rule.*"typesafe-ai\/jev"/);
    });

    it('looks answers up under an explicit model label', async () => {
        const question: NoulQuestion = { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } };
        writeJsonAtomic(shardedPath(cacheDir, 'q', questionCacheKey('jev-1.13.0', JSON.stringify({ code: 'x' }), question)), { noul: 0.2 });
        const client = createJevClient({ cacheDir, useCache: true, provider: { kind: 'replay', model: 'jev-1.13.0' } });
        expect(await client.ask({ code: 'x' }, { q: question })).toEqual({ q: 0.2 });
    });

    it('never reaches the network even when useCache is false (there is nowhere else for it to look)', async () => {
        const client = createJevClient({ cacheDir, useCache: false, provider: { kind: 'replay' } });
        const question: NoulQuestion = { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } };
        await expect(client.ask({ file: 'src/a.ts', code: 'x' }, { 'demo/rule': question })).rejects.toThrow(JevlintReplayMissError);
    });
});

describe('provider keys', () => {
    it('reads the key only from the environment and names the variable when it is missing', () => {
        expect(() => resolveProvider({ kind: 'gateway' }, {})).toThrow(/AI_GATEWAY_API_KEY is not set/);
        expect(() => resolveProvider({ kind: 'typesafe', keyEnv: 'MY_KEY' }, {})).toThrow(/MY_KEY is not set/);
        expect(() => resolveProvider(undefined, {})).toThrow(JevlintProviderKeyError);
        expect(() => resolveProvider(undefined, {})).toThrow(/AI_GATEWAY_API_KEY .* or TYPESAFE_API_KEY/);
        expect(resolveProvider(undefined, { AI_GATEWAY_API_KEY: 'k' }).name).toBe('gateway');
        expect(resolveProvider(undefined, { TYPESAFE_API_KEY: 'k' }).name).toBe('typesafe');
    });
});

describe('provider errors', () => {
    let cacheDir: string;

    beforeEach(() => {
        cacheDir = mkdtempSync(join(tmpdir(), 'jevlint-client-test-'));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        rmSync(cacheDir, { recursive: true, force: true });
    });

    it('turns a rejected key into a message naming the variable, never the key', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
        const client = createJevClient({ cacheDir, useCache: false, provider: { kind: 'gateway', keyEnv: 'TEST_KEY' }, env: { TEST_KEY: 'test-value-not-a-secret' } });
        const question: NoulQuestion = { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } };
        const failure = client.ask({ code: 'x' }, { q: question });
        await expect(failure).rejects.toThrow(JevlintRequestError);
        await expect(client.ask({ code: 'x' }, { q: question })).rejects.toThrow(/rejected the API key in TEST_KEY \(HTTP 401\)/);
        await expect(client.ask({ code: 'x' }, { q: question })).rejects.not.toThrow(/test-value-not-a-secret/);
    });

    it('parses answers and caches them for the next ask', async () => {
        const fetch = vi.fn(async () => Response.json({ answers: { q: { type: 'noul', noul: 0.87 } }, usage: { input_tokens: 12 } }));
        vi.stubGlobal('fetch', fetch);
        const client = createJevClient({ cacheDir, useCache: true, provider: { kind: 'typesafe' }, env: { TYPESAFE_API_KEY: 'k' } });
        const question: NoulQuestion = { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } };
        expect(await client.ask({ code: 'x' }, { q: question })).toEqual({ q: 0.87 });
        expect(await client.ask({ code: 'x' }, { q: question })).toEqual({ q: 0.87 });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(client.stats).toMatchObject({ requests: 1, inputTokens: 12, cacheHits: 1 });
    });
});

describe('network failures', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('retries an unreachable endpoint, then names the host and the cause', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn(async () => {
            throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
        });
        vi.stubGlobal('fetch', fetch);
        const cacheDir = mkdtempSync(join(tmpdir(), 'jevlint-network-test-'));
        try {
            const client = createJevClient({ cacheDir, useCache: false, provider: { kind: 'gateway' }, env: { AI_GATEWAY_API_KEY: 'k' } });
            const question: NoulQuestion = { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } };
            const asked = client.ask({ code: 'x' }, { q: question });
            const settled = expect(asked).rejects.toThrow(/Could not reach gateway \(ai-gateway\.vercel\.sh\) after 8 attempts: ENOTFOUND/);
            await vi.runAllTimersAsync();
            await settled;
            expect(fetch).toHaveBeenCalledTimes(8);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});

describe('rate limiting', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('backs off on 429 and, when it never clears, suggests lowering concurrency', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn(async () => new Response('slow down', { status: 429 }));
        vi.stubGlobal('fetch', fetch);
        const cacheDir = mkdtempSync(join(tmpdir(), 'jevlint-429-test-'));
        try {
            const client = createJevClient({ cacheDir, useCache: false, provider: { kind: 'gateway' }, env: { AI_GATEWAY_API_KEY: 'k' } });
            const question: NoulQuestion = { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } };
            const settled = expect(client.ask({ code: 'x' }, { q: question })).rejects.toThrow(/still rate limiting after 8 attempts \(HTTP 429\)\. Lower `concurrency`/);
            await vi.runAllTimersAsync();
            await settled;
            expect(client.stats.throttled).toBe(7);
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});
