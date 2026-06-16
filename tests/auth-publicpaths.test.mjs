import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicPath } from '../lib/auth/publicPaths.js';

test('the login page and login API are public', () => {
    assert.equal(isPublicPath('/login'), true);
    assert.equal(isPublicPath('/login/'), true);
    assert.equal(isPublicPath('/api/auth/login'), true);
});

test('gated app pages and APIs are NOT public', () => {
    assert.equal(isPublicPath('/'), false);
    assert.equal(isPublicPath('/seedance'), false);
    assert.equal(isPublicPath('/api/seedance/prompts'), false);
    assert.equal(isPublicPath('/api/byteplus/contents/generations/tasks'), false);
});

test('REGRESSION: a static-extension suffix on an /api/* path does NOT bypass the gate', () => {
    // Was a critical auth bypass: `.js`/`.css`/etc. suffix made the gate skip
    // the key-spending proxy routes.
    assert.equal(isPublicPath('/api/byteplus/contents/generations/tasks.js'), false);
    assert.equal(isPublicPath('/api/seedance/prompts.js'), false);
    assert.equal(isPublicPath('/api/v1/anything.css'), false);
    assert.equal(isPublicPath('/api/byteplus/x.png'), false);
});

test('the /login prefix does not over-match unrelated routes', () => {
    assert.equal(isPublicPath('/loginXYZ'), false);
    assert.equal(isPublicPath('/login-secret'), false);
});

test('the /api/auth allowlist is exact (no broad subtree)', () => {
    assert.equal(isPublicPath('/api/auth/other'), false);
    assert.equal(isPublicPath('/api/auth/login/extra'), false);
});

test('non-API static assets remain public', () => {
    assert.equal(isPublicPath('/banner.png'), true);
    assert.equal(isPublicPath('/styles/main.css'), true);
    assert.equal(isPublicPath('/fonts/inter.woff2'), true);
});
