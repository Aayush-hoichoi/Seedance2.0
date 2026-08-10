import test from 'node:test';
import assert from 'node:assert/strict';

// Regression cover for two live incidents where TOS auth failures were reported
// as bucket failures, sending the on-call person to look at object storage when
// the real cause was the credential:
//   • 2026-08-08  ARK_AK deleted in BytePlus  -> 403 InvalidAccessKeyId
//   • 2026-08-10  ARK_AK contained "/" or "=" -> 400 AuthorizationHeaderMalformed
// Both surfaced to users as 'Could not create the TOS bucket'.
//
// Verified against the real TOS endpoint: an access key containing "/" or "="
// (or an empty one) yields AuthorizationHeaderMalformed, because TOS4 signs
// `Credential=<ak>/<date>/<region>/tos/request` and splits it on "/". Every
// other bad value — wrong key, "+", spaces, quotes — yields InvalidAccessKeyId.

const ENV_KEYS = ['ARK_AK', 'ARK_SK', 'TOS_BUCKET'];

async function withEnv(vars, fn) {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
        // Re-import per case: the module reads TOS_BUCKET at load time.
        return await fn(await import(`../lib/byteplus/uploadUrl.js?case=${encodeURIComponent(JSON.stringify(vars))}`));
    } finally {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

const GOOD_AK = `AKAP${'a'.repeat(43)}`;
const GOOD_SK = 'b'.repeat(60);

test('missing credentials are reported as configuration, not as a bucket failure', async () => {
    await withEnv({ ARK_AK: '', ARK_SK: '' }, async (mod) => {
        const { error } = await mod.presignUpload({ name: 'x.png' });
        assert.equal(error, mod.MISSING_CREDENTIALS_ERROR);
        assert.doesNotMatch(error, /bucket/i, 'a missing key is not a bucket problem');
    });
});

// The 2026-08-10 incident: a secret key (padded base64, so it carries "/" and
// "=") pasted into ARK_AK. Caught before any network call — an unsignable
// credential can only come back as an opaque 400.
for (const [label, ak] of [
    ['slash (AK/SK pasted as one value)', `AKAP${'a'.repeat(20)}/${'b'.repeat(22)}`],
    ['base64 padding', `AKAP${'a'.repeat(41)}==`],
    ['wrapping quotes', `"${GOOD_AK}"`],
    ['stray whitespace inside', `AKAP ${'a'.repeat(42)}`],
]) {
    test(`an access key with ${label} is rejected before signing`, async () => {
        await withEnv({ ARK_AK: ak, ARK_SK: GOOD_SK }, async (mod) => {
            const { error, putUrl } = await mod.presignUpload({ name: 'x.png' });
            assert.equal(error, mod.MALFORMED_AK_ERROR);
            assert.equal(putUrl, undefined, 'must not hand back a URL signed with a broken credential');
            assert.match(error, /ARK_AK/, 'the message must name the variable to fix');
            assert.doesNotMatch(error, /bucket/i, 'a bad key is not a bucket problem');
        });
    });
}

test('a well-formed key is not rejected by the shape guard', async () => {
    await withEnv({ ARK_AK: GOOD_AK, ARK_SK: GOOD_SK }, async (mod) => {
        // Reaches the network (and fails there, offline or on a fake key) —
        // the point is only that it is NOT stopped by the local shape check.
        const { error } = await mod.presignUpload({ name: 'x.png' });
        if (error) assert.notEqual(error, mod.MALFORMED_AK_ERROR);
    });
});
