import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOpenAiFailure, retryDelayMs } from '../lib/openai/rateLimit.mjs';
import { MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, STYLES } from '../lib/openai/styleBriefs.js';

// The bug this guards: OpenAI answers BOTH "your org's TPM window is full"
// (transient) and "your account is out of credit" (permanent) with a bare 429.
// The enhance route used to render both as "try again", so an exhausted OpenAI
// account looked like a flaky app — users retried for days and nobody checked
// billing.

test('an out-of-credit 429 is terminal, not a retry', () => {
    const quota = {
        status: 429,
        body: { error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } },
    };
    assert.deepEqual(classifyOpenAiFailure(quota), { kind: 'quota', retryable: false });
});

test('a rate-limit 429 is retryable', () => {
    const limited = {
        status: 429,
        body: { error: { code: 'rate_limit_exceeded', type: 'requests', message: 'Rate limit reached for gpt-5.6-luna in organization org-x on tokens per min (TPM).' } },
    };
    assert.deepEqual(classifyOpenAiFailure(limited), { kind: 'rate_limit', retryable: true });
});

test('a 429 with no usable body defaults to retryable, not to a billing accusation', () => {
    // Better to waste three retries than to tell an admin their card failed when it didn't.
    assert.deepEqual(classifyOpenAiFailure({ status: 429, body: null }), { kind: 'rate_limit', retryable: true });
});

test('5xx retries; 4xx policy errors do not', () => {
    assert.equal(classifyOpenAiFailure({ status: 503, body: null }).retryable, true);
    assert.equal(classifyOpenAiFailure({ status: 400, body: { error: { message: 'Unknown model' } } }).retryable, false);
    assert.equal(classifyOpenAiFailure({ status: 401, body: null }).retryable, false);
});

// --- backoff -------------------------------------------------------------------

test("OpenAI's own retry hint wins over our exponential guess", () => {
    const headers = new Map([['retry-after-ms', '250']]);
    assert.equal(retryDelayMs({ attempt: 3, headers: { get: (k) => headers.get(k) ?? null } }), 250);

    const seconds = new Map([['retry-after', '2']]);
    assert.equal(retryDelayMs({ attempt: 0, headers: { get: (k) => seconds.get(k) ?? null } }), 2000);
});

test('without a hint, backoff grows exponentially and carries jitter', () => {
    const none = { get: () => null };
    assert.equal(retryDelayMs({ attempt: 0, headers: none, random: () => 0 }), 1000);
    assert.equal(retryDelayMs({ attempt: 1, headers: none, random: () => 0 }), 2000);
    assert.equal(retryDelayMs({ attempt: 2, headers: none, random: () => 0 }), 4000);
    // Jitter so a burst of users that 429'd together doesn't retry in lockstep.
    assert.equal(retryDelayMs({ attempt: 0, headers: none, random: () => 1 }), 1400);
});

// --- output caps ---------------------------------------------------------------

test('every style has an output cap, since the flat 16384 reserved TPM nothing spent', () => {
    for (const style of Object.keys(STYLES)) {
        const cap = MAX_OUTPUT_TOKENS[style] ?? DEFAULT_MAX_OUTPUT_TOKENS;
        assert.ok(cap > 0, `${style} has no cap`);
        // Must clear the template the style asks the model to reproduce verbatim,
        // or the brief truncates mid-lock-section. ~1 token / 4 chars.
        const templateTokens = STYLES[style].system.length / 4;
        assert.ok(cap > templateTokens, `${style} cap ${cap} is below its own template (~${Math.round(templateTokens)} tok)`);
    }
});

test('the caps still cut the old flat reservation', () => {
    assert.ok(Math.max(...Object.values(MAX_OUTPUT_TOKENS)) < 16384);
});
