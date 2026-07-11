import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFreshVideoUrl } from '../lib/seedance/videoUrl.js';

const json = (body) => ({ ok: true, json: async () => body });
const gone = { ok: false, json: async () => ({}) };

test('prefers the archived copy when the probe confirms it exists', async () => {
    const fetchFn = async (url) => {
        if (url.startsWith('/api/byteplus/archive?key=videos%2Ft-1.mp4')) return json({ url: 'https://tos/archived.mp4?sig' });
        if (url === 'https://tos/archived.mp4?sig') return { ok: true }; // probe
        throw new Error(`unexpected fetch: ${url}`);
    };
    assert.equal(await resolveFreshVideoUrl('t-1', fetchFn), 'https://tos/archived.mp4?sig');
});

test('falls back to the live task when the archive was never written', async () => {
    const fetchFn = async (url) => {
        if (url.startsWith('/api/byteplus/archive')) return json({ url: 'https://tos/missing.mp4' });
        if (url === 'https://tos/missing.mp4') return { ok: false }; // presign "succeeds", object 404s
        if (url === '/api/byteplus/contents/generations/tasks/t-2') return json({ content: { video_url: 'https://ark/live.mp4' } });
        throw new Error(`unexpected fetch: ${url}`);
    };
    assert.equal(await resolveFreshVideoUrl('t-2', fetchFn), 'https://ark/live.mp4');
});

test('returns null when both the archive and the live task are gone', async () => {
    const fetchFn = async (url) => {
        if (url.startsWith('/api/byteplus/archive')) return json({ url: 'https://tos/missing.mp4' });
        if (url === 'https://tos/missing.mp4') return { ok: false };
        return gone; // live task record aged out
    };
    assert.equal(await resolveFreshVideoUrl('t-3', fetchFn), null);
});

test('prefers the live URL over an archived one the probe could not verify', async () => {
    const fetchFn = async (url) => {
        if (url.startsWith('/api/byteplus/archive')) return json({ url: 'https://tos/blocked.mp4' });
        if (url === 'https://tos/blocked.mp4') throw new TypeError('CORS');
        return json({ content: { video_url: 'https://ark/live.mp4' } });
    };
    assert.equal(await resolveFreshVideoUrl('t-4', fetchFn), 'https://ark/live.mp4');
});

test('an unverifiable archived URL is still returned as a last resort', async () => {
    const fetchFn = async (url) => {
        if (url.startsWith('/api/byteplus/archive')) return json({ url: 'https://tos/blocked.mp4' });
        if (url === 'https://tos/blocked.mp4') throw new TypeError('CORS');
        return gone; // live task gone too
    };
    assert.equal(await resolveFreshVideoUrl('t-5', fetchFn), 'https://tos/blocked.mp4');
});

test('rejects a missing task id without any network calls', async () => {
    const fetchFn = async () => { throw new Error('must not fetch'); };
    assert.equal(await resolveFreshVideoUrl(null, fetchFn), null);
    assert.equal(await resolveFreshVideoUrl('  ', fetchFn), null);
});
