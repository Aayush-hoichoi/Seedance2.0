import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { archiveProResDownload } from '../lib/seedance/archiveDownload.mjs';

const PART = 8 * 1024 * 1024;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function configure(t) {
    const saved = { ARK_AK: process.env.ARK_AK, ARK_SK: process.env.ARK_SK, TOS_BUCKET: process.env.TOS_BUCKET };
    Object.assign(process.env, { ARK_AK: 'test-access-key', ARK_SK: 'private-test-secret', TOS_BUCKET: 'test-private-downloads' });
    t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
}

function fakeStorage(t, { part, complete, create } = {}) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (input, options) => {
        const url = new URL(input);
        const call = { url, ...options };
        calls.push(call);
        assert.equal(url.origin, 'https://test-private-downloads.tos-ap-southeast-1.bytepluses.com');
        assert.match(options.headers.Authorization, /^TOS4-HMAC-SHA256 /);
        if (url.searchParams.has('uploads')) {
            return create ? create(call) : Response.json({ UploadId: 'test/id+=1' });
        }
        if (options.method === 'DELETE') return new Response(null, { status: 204 });
        assert.equal(url.searchParams.get('uploadId'), 'test/id+=1');
        if (options.method === 'PUT') {
            assert.equal(Number(options.headers['Content-Length']), options.body.length);
            assert.equal(options.headers['Content-Md5'], createHash('md5').update(options.body).digest('base64'));
            call.digest = createHash('sha256').update(options.body).digest('hex');
            call.length = options.body.length;
            return part ? part(call) : new Response(null, { headers: { ETag: `"part-${url.searchParams.get('partNumber')}"` } });
        }
        if (options.method === 'POST') return complete ? complete(call) : Response.json({ ETag: '"complete"' });
        assert.fail(`Unexpected storage method ${options.method}`);
    });
    return calls;
}

function conversionFrom(stream, completion) {
    const closed = deferred();
    const conversion = {
        stream,
        cancelCalls: 0,
        cancel() { conversion.cancelCalls += 1; stream.destroy(); closed.resolve(); },
        done: completion || closed.promise,
    };
    stream.once('end', closed.resolve);
    stream.once('close', closed.resolve);
    return conversion;
}

test('archives sequential bounded parts, waits for encoder completion, and signs a private attachment', async (t) => {
    configure(t);
    const firstPart = deferred();
    const childClose = deferred();
    let produced = 0;
    const sourceBytes = PART * 2 + 123;
    const source = Readable.from((async function* () {
        while (produced < sourceBytes) {
            const size = Math.min(65536, sourceBytes - produced);
            produced += size;
            yield Buffer.alloc(size, 0x39);
        }
    })(), { objectMode: false, highWaterMark: 65536 });
    let active = 0;
    let maximum = 0;
    const calls = fakeStorage(t, { part: async (call) => {
        maximum = Math.max(maximum, ++active);
        if (call.url.searchParams.get('partNumber') === '1') await firstPart.promise;
        active -= 1;
        return new Response(null, { headers: { ETag: `"part-${call.url.searchParams.get('partNumber')}"` } });
    } });
    const conversion = conversionFrom(source, childClose.promise);
    const resultPromise = archiveProResDownload({ conversion, name: 'A Bengali দৃশ্য\r\n"/clip.mp4' });
    while (!calls.some((call) => call.method === 'PUT')) await tick();
    await tick();
    assert.ok(produced <= PART + 2 * 65536, 'a stalled storage PUT must backpressure the encoder');
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
    firstPart.resolve();
    while (!source.readableEnded) await tick();
    assert.equal(calls.some((call) => call.method === 'POST' && call.url.searchParams.has('uploadId')), false, 'do not publish before actual encoder close');
    childClose.resolve();
    const result = await resultPromise;
    assert.equal(maximum, 1);
    assert.equal(result.bytes, sourceBytes);
    assert.equal(result.name, 'A Bengali দৃশ্য_clip.mov');
    assert.match(result.key, /^downloads\/[0-9a-f-]{36}\.mov$/);
    const signed = new URL(result.url);
    assert.equal(signed.pathname, `/${result.key}`);
    assert.equal(signed.searchParams.get('X-Tos-Expires'), '3600');
    assert.equal(signed.hostname, 'test-private-downloads.tos-ap-southeast-1.bytepluses.com');
    const init = calls[0];
    assert.equal(init.headers['Content-Type'], 'video/quicktime');
    assert.match(init.headers['Content-Disposition'], /^attachment; filename=/);
    assert.match(init.headers['Content-Disposition'], /filename\*=UTF-8''/);
    assert.doesNotMatch(init.headers['Content-Disposition'], /[\r\n]/);
    assert.equal(init.headers['X-Tos-Acl'], 'private');
    assert.equal(init.headers['X-Tos-Object-Expires'], '1');
    assert.match(init.headers.Authorization, /SignedHeaders=[^,]*x-tos-object-expires/);
    const parts = calls.filter((call) => call.method === 'PUT');
    assert.deepEqual(parts.map((call) => call.length), [PART, PART, 123]);
    assert.deepEqual(JSON.parse(calls.at(-1).body), { Parts: [1, 2, 3].map((PartNumber) => ({ PartNumber, ETag: `"part-${PartNumber}"` })) });
    assert.equal(conversion.cancelCalls, 0);
});

test('a truncated conversion never completes or returns a partial MOV URL', async (t) => {
    configure(t);
    const calls = fakeStorage(t);
    const stream = Readable.from((async function* () {
        yield Buffer.alloc(PART, 7);
        throw new Error('private-source?Signature=must-not-leak');
    })(), { objectMode: false });
    const conversion = conversionFrom(stream);
    await assert.rejects(archiveProResDownload({ conversion, name: 'movie.mp4' }), (error) => {
        assert.match(error.message, /ProRes.*failed/i);
        assert.doesNotMatch(error.message, /private-source|Signature|must-not-leak/);
        return true;
    });
    assert.equal(calls.some((call) => call.method === 'POST' && call.url.searchParams.has('uploadId')), false);
    assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.searchParams.get('uploadId') === 'test/id+=1'));
    assert.ok(conversion.cancelCalls >= 1);
});

test('failed part upload aborts multipart and does not release before encoder exit', async (t) => {
    configure(t);
    const childClose = deferred();
    const calls = fakeStorage(t, { part: () => new Response('secret upstream failure', { status: 503 }) });
    const conversion = conversionFrom(Readable.from([Buffer.alloc(PART)], { objectMode: false }), childClose.promise);
    let settled = false;
    const pending = archiveProResDownload({ conversion, name: 'movie.mp4' }).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, (error) => !error.message.includes('secret upstream failure'));
    while (!conversion.cancelCalls) await tick();
    assert.equal(settled, false);
    childClose.resolve();
    await rejected;
    assert.ok(calls.some((call) => call.method === 'DELETE'));
    assert.equal(calls.some((call) => call.method === 'POST' && call.url.searchParams.has('uploadId')), false);
});

test('request cancellation interrupts a stalled upload and uses a fresh signal for cleanup', async (t) => {
    configure(t);
    const controller = new AbortController();
    const uploading = deferred();
    const calls = fakeStorage(t, { part: (call) => new Promise((_resolve, reject) => {
        uploading.resolve();
        call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
    }) });
    const conversion = conversionFrom(Readable.from([Buffer.alloc(PART)], { objectMode: false }));
    const pending = archiveProResDownload({ conversion, name: 'movie.mp4', signal: controller.signal });
    const rejected = assert.rejects(pending, /canceled|cancelled/i);
    await uploading.promise;
    controller.abort(new Error('private request detail'));
    await rejected;
    const cleanup = calls.find((call) => call.method === 'DELETE');
    assert.ok(cleanup);
    assert.equal(cleanup.signal.aborted, false);
    assert.ok(conversion.cancelCalls >= 1);
});

test('missing credentials cancel the already-started encoder before returning a safe configuration error', async (t) => {
    configure(t);
    delete process.env.ARK_AK;
    const calls = fakeStorage(t);
    const conversion = conversionFrom(new PassThrough());
    await assert.rejects(archiveProResDownload({ conversion, name: 'movie.mp4' }), (error) => error.code === 'VIDEO_DOWNLOAD_STORAGE_UNAVAILABLE');
    assert.equal(calls.length, 0);
    assert.ok(conversion.cancelCalls >= 1);
});

test('an encoder failure during upload initialization is handled and never publishes a file', async (t) => {
    configure(t);
    const stream = new PassThrough();
    const calls = fakeStorage(t, { create: async () => {
        stream.destroy(new Error('private-source-url'));
        await tick();
        return Response.json({ UploadId: 'test/id+=1' });
    } });
    await assert.rejects(archiveProResDownload({ conversion: conversionFrom(stream), name: 'movie.mp4' }), /ProRes.*failed/i);
    assert.equal(calls.some((call) => call.method === 'PUT'), false);
    assert.ok(calls.some((call) => call.method === 'DELETE'));
});

test('an empty converted stream cannot create a successful downloadable object', async (t) => {
    configure(t);
    const calls = fakeStorage(t);
    await assert.rejects(archiveProResDownload({ conversion: conversionFrom(Readable.from([])), name: 'movie.mp4' }), /ProRes.*failed/i);
    assert.ok(calls.some((call) => call.method === 'DELETE'));
    assert.equal(calls.some((call) => call.method === 'POST' && call.url.searchParams.has('uploadId')), false);
});

test('a failed completion removes provisional parts and its unique possibly-committed object', async (t) => {
    configure(t);
    const calls = fakeStorage(t, { complete: () => { throw new Error('https://private-url?Signature=secret'); } });
    await assert.rejects(archiveProResDownload({
        conversion: conversionFrom(Readable.from([Buffer.alloc(1024)], { objectMode: false })), name: 'movie.mp4',
    }), (error) => !/private-url|Signature|secret/.test(error.message));
    const deletes = calls.filter((call) => call.method === 'DELETE');
    assert.equal(deletes.length, 2);
    assert.equal(deletes[0].url.searchParams.get('uploadId'), 'test/id+=1');
    assert.equal(deletes[1].url.search, '');
    assert.equal(deletes[1].url.pathname, calls[0].url.pathname);
    assert.match(deletes[1].url.pathname, /^\/downloads\/[0-9a-f-]{36}\.mov$/);
});

test('a missing part ETag prevents publishing an unverifiable multipart file', async (t) => {
    configure(t);
    const calls = fakeStorage(t, { part: () => new Response(null) });
    await assert.rejects(archiveProResDownload({
        conversion: conversionFrom(Readable.from([Buffer.alloc(1024)], { objectMode: false })), name: 'movie.mp4',
    }), /ProRes.*failed/i);
    assert.equal(calls.some((call) => call.method === 'POST' && call.url.searchParams.has('uploadId')), false);
    assert.ok(calls.some((call) => call.method === 'DELETE'));
});

test('the preparation deadline cancels a stalled upload while cleanup still has time to run', async (t) => {
    configure(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const uploading = deferred();
    const calls = fakeStorage(t, { part: (call) => new Promise((_resolve, reject) => {
        uploading.resolve();
        call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
    }) });
    const conversion = conversionFrom(Readable.from([Buffer.alloc(PART)], { objectMode: false }));
    const pending = archiveProResDownload({ conversion, name: 'movie.mp4' });
    const rejected = assert.rejects(pending, /timed out/i);
    await uploading.promise;
    t.mock.timers.tick(275_000);
    await rejected;
    assert.ok(conversion.cancelCalls >= 1);
    const cleanup = calls.find((call) => call.method === 'DELETE');
    assert.ok(cleanup);
    assert.equal(cleanup.signal.aborted, false);
});
