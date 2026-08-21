// OpenAI returns 429 for two conditions that need OPPOSITE handling, and the
// bodies are the only way to tell them apart:
//
//   • rate_limit_exceeded  — the org's TPM/RPM window is full. Transient;
//     retrying a second later usually works.
//   • insufficient_quota   — the account is out of credit. Retrying NEVER
//     works, and telling the user to "try again" wastes their time and hides a
//     billing problem from whoever can actually fix it.
//
// Collapsing both into one "try again" message is how an exhausted OpenAI
// account can look like a flaky app for days. Keep them distinct.
//
// `.mjs` so both the Next route and `node --test` can load it (the repo has no
// type:module, so a plain `.js` lib isn't directly unit-testable) — same reason
// as lib/openai/refusal.mjs.

const QUOTA_RE = /insufficient_quota|exceeded your current quota|billing_hard_limit|check your plan and billing/i;

// → { kind, retryable }. `kind` is for choosing the user-facing sentence;
// `retryable` is the only thing the retry loop reads.
export function classifyOpenAiFailure({ status, body } = {}) {
    const error = body?.error || {};
    const fingerprint = `${error.code || ''} ${error.type || ''} ${error.message || ''}`;

    if (status === 429) {
        // Quota exhaustion is terminal — never burn the request budget on it.
        if (QUOTA_RE.test(fingerprint)) return { kind: 'quota', retryable: false };
        return { kind: 'rate_limit', retryable: true };
    }
    // 5xx is OpenAI having a bad moment, not us sending something wrong.
    if (status >= 500) return { kind: 'server', retryable: true };
    return { kind: 'other', retryable: false };
}

// How long to wait before attempt N+1. OpenAI's own hint wins when it sends one
// (`retry-after-ms` is the precise variant, `retry-after` the whole-second RFC
// one); otherwise exponential 1s/2s/4s. Jitter keeps a burst of users that all
// 429'd together from retrying in lockstep and 429ing together again.
export function retryDelayMs({ attempt, headers, random = Math.random } = {}) {
    // Number(null) and Number('') are both 0 — a missing header would read as
    // "retry immediately" and hammer an already-saturated key. Demand a value.
    const get = (name) => {
        const raw = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
        if (raw === null || raw === undefined || String(raw).trim() === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };

    const ms = get('retry-after-ms');
    if (ms !== null) return ms;

    const seconds = get('retry-after');
    if (seconds !== null) return seconds * 1000;

    return 1000 * 2 ** attempt + random() * 400;
}
