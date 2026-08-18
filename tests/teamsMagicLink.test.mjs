// Signed links that decide a Teams budget-approval card with no inbound Bot
// Framework endpoint at all.
//
// THE POINT OF THIS FILE: the link itself is the credential. There is no
// session, no Teams JWT, no AAD identity check on the request that decides a
// request — only whatever the signature proves. So the signature has to
// actually bind every field that matters (which request, which admin, which
// action), not just prove "a card was sent at some point".

import test from 'node:test';
import assert from 'node:assert/strict';
import { signApprovalToken, verifyApprovalToken } from '../lib/teams/magicLink.mjs';

function withSecret(fn) {
    const saved = process.env.TEAMS_APP_PASSWORD;
    process.env.TEAMS_APP_PASSWORD = 'test-secret';
    return Promise.resolve().then(fn).finally(() => { process.env.TEAMS_APP_PASSWORD = saved; });
}

test('a signed token round-trips to the exact payload it was minted with', () => withSecret(() => {
    const token = signApprovalToken({ requestId: 'req-1', adminUserId: 'user-1', aadObjectId: 'aad-1', action: 'approve' });
    const result = verifyApprovalToken(token);
    assert.equal(result.ok, true);
    assert.equal(result.payload.requestId, 'req-1');
    assert.equal(result.payload.adminUserId, 'user-1');
    assert.equal(result.payload.aadObjectId, 'aad-1');
    assert.equal(result.payload.action, 'approve');
}));

test('changing the requestId in the payload invalidates the signature', () => withSecret(() => {
    const token = signApprovalToken({ requestId: 'req-1', adminUserId: 'user-1', aadObjectId: 'aad-1', action: 'approve' });
    const [, sig] = token.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({
        requestId: 'req-2', adminUserId: 'user-1', aadObjectId: 'aad-1', action: 'approve', exp: Date.now() + 1000,
    })).toString('base64url');
    assert.equal(verifyApprovalToken(`${tamperedBody}.${sig}`).ok, false, 'a different request must not be approvable with this link');
}));

test('changing approve to deny in the payload invalidates the signature', () => withSecret(() => {
    const token = signApprovalToken({ requestId: 'req-1', adminUserId: 'user-1', aadObjectId: 'aad-1', action: 'approve' });
    const [, sig] = token.split('.');
    const tamperedBody = Buffer.from(JSON.stringify({
        requestId: 'req-1', adminUserId: 'user-1', aadObjectId: 'aad-1', action: 'deny', exp: Date.now() + 1000,
    })).toString('base64url');
    assert.equal(verifyApprovalToken(`${tamperedBody}.${sig}`).ok, false, 'a deny link must not be upgradable to approve');
}));

test('an expired token is rejected even with a valid signature', () => withSecret(() => {
    const token = signApprovalToken({ requestId: 'req-1', adminUserId: 'user-1', aadObjectId: 'aad-1', action: 'deny', ttlMs: -1 });
    const result = verifyApprovalToken(token);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
}));

test('a token signed under a different secret is rejected', () => {
    process.env.TEAMS_APP_PASSWORD = 'secret-a';
    const token = signApprovalToken({ requestId: 'req-1', adminUserId: 'user-1', aadObjectId: 'aad-1', action: 'approve' });
    process.env.TEAMS_APP_PASSWORD = 'secret-b';
    const result = verifyApprovalToken(token);
    process.env.TEAMS_APP_PASSWORD = undefined;
    assert.equal(result.ok, false, 'a link minted before a secret rotation must not survive it');
});

test('malformed or empty tokens are rejected without throwing', () => withSecret(() => {
    for (const bad of ['', 'not-a-token', 'a.b', 'onlyonepart', null, undefined]) {
        assert.equal(verifyApprovalToken(bad).ok, false, `${JSON.stringify(bad)} must not verify`);
    }
}));

test('verifying with no secret configured fails closed, not open', () => {
    const saved = process.env.TEAMS_APP_PASSWORD;
    delete process.env.TEAMS_APP_PASSWORD;
    delete process.env.TEAMS_LINK_SECRET;
    try {
        assert.equal(verifyApprovalToken('anything.at-all').ok, false);
    } finally {
        if (saved !== undefined) process.env.TEAMS_APP_PASSWORD = saved;
    }
});
