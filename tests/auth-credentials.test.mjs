import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AUTH_COOKIE,
    sha256Hex,
    cookieValueFor,
    safeEqual,
    getAuthConfig,
    expectedCookieValue,
    credentialsMatch,
    cookieMatches,
} from '../lib/auth/credentials.js';

test('AUTH_COOKIE name', () => {
    assert.equal(AUTH_COOKIE, 'll_auth');
});

test('sha256Hex matches a known vector (echo -n "abc" | shasum -a 256)', async () => {
    assert.equal(
        await sha256Hex('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
});

test('cookieValueFor is 64-hex of user:pass and deterministic', async () => {
    const v = await cookieValueFor('LoglineAI', 'LoglineAI');
    assert.match(v, /^[0-9a-f]{64}$/);
    assert.equal(v, await sha256Hex('LoglineAI:LoglineAI'));
});

test('safeEqual compares values without type coercion surprises', () => {
    assert.equal(safeEqual('a', 'a'), true);
    assert.equal(safeEqual('a', 'b'), false);
    assert.equal(safeEqual('a', 'aa'), false);
    assert.equal(safeEqual('a', 1), false);
});

test('getAuthConfig throws when env is unset', () => {
    delete process.env.APP_AUTH_USERNAME;
    delete process.env.APP_AUTH_PASSWORD;
    assert.throws(() => getAuthConfig(), /Auth not configured/);
});

test('credentialsMatch true/false with env set', () => {
    process.env.APP_AUTH_USERNAME = 'LoglineAI';
    process.env.APP_AUTH_PASSWORD = 'LoglineAI';
    assert.equal(credentialsMatch('LoglineAI', 'LoglineAI'), true);
    assert.equal(credentialsMatch('LoglineAI', 'wrong'), false);
    assert.equal(credentialsMatch('nope', 'LoglineAI'), false);
    assert.equal(credentialsMatch('', ''), false);
});

test('cookieMatches: expected value passes, anything else fails', async () => {
    process.env.APP_AUTH_USERNAME = 'LoglineAI';
    process.env.APP_AUTH_PASSWORD = 'LoglineAI';
    const good = await expectedCookieValue();
    assert.equal(await cookieMatches(good), true);
    assert.equal(await cookieMatches('deadbeef'), false);
    assert.equal(await cookieMatches(''), false);
    assert.equal(await cookieMatches(undefined), false);
});

test('cookieMatches fails closed when unconfigured', async () => {
    delete process.env.APP_AUTH_USERNAME;
    delete process.env.APP_AUTH_PASSWORD;
    assert.equal(await cookieMatches('whatever'), false);
});
