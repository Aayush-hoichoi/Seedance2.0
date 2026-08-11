import test from 'node:test';
import assert from 'node:assert/strict';
import { seedreamRefs, submit } from '../lib/gateway/providers/byteplus.mjs';

// Seedream 5.0 Pro shipped with reference images accepted by the UI and thrown
// away by the adapter. submit() built a "clean" images/generations body of
// model/prompt/size/response_format/watermark and dropped the whole `parts`
// array — where the studio stores refs — without mapping it to anything. All 20
// Seedream jobs in production carried references; not one reached the model, so
// a prompt like "change the lamp in Image 1 to the one from Image 2" was
// answered from the text alone and nothing told the user.
//
// Verified against the live API: `image` is a real parameter (an invalid value
// returns "The parameter `image` ... is not valid: invalid url specified"),
// whereas an unknown field is silently ignored — which is exactly why this
// failed quietly rather than erroring.

const B64 = Buffer.from('pretend-image-bytes').toString('base64');
const ref = (mimeType = 'image/jpeg', data = B64) => ({ inlineData: { mimeType, data } });

test('a reference becomes a data: URI carrying its own mime type', () => {
    assert.deepEqual(seedreamRefs([ref('image/jpeg')]), [`data:image/jpeg;base64,${B64}`]);
    assert.deepEqual(seedreamRefs([ref('image/webp')]), [`data:image/webp;base64,${B64}`]);
});

test('text parts are dropped — the instruction already travels as `prompt`', () => {
    const refs = seedreamRefs([{ text: 'change the lamp' }, ref(), { text: 'more words' }]);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].startsWith('data:image/jpeg;base64,'));
});

test('a missing or bogus mime type falls back rather than emitting a broken URI', () => {
    // Built literally rather than through ref(), whose default would mask the
    // undefined case this is meant to cover.
    for (const bad of [undefined, '', 'not-a-mime', 'text/plain', 'image/png; charset=utf-8']) {
        const part = { inlineData: { mimeType: bad, data: B64 } };
        assert.deepEqual(seedreamRefs([part]), [`data:image/png;base64,${B64}`],
            `mimeType ${JSON.stringify(bad)} must not reach the API verbatim`);
    }
    // ...and a legitimate one is still preserved, so the guard isn't just
    // flattening everything to png.
    assert.deepEqual(seedreamRefs([{ inlineData: { mimeType: 'image/webp', data: B64 } }]),
        [`data:image/webp;base64,${B64}`]);
});

test('an already-complete data: URI is passed through, not double-prefixed', () => {
    const already = `data:image/png;base64,${B64}`;
    assert.deepEqual(seedreamRefs([{ inlineData: { mimeType: 'image/png', data: already } }]), [already],
        'double-prefixing produces "invalid url specified" from the API');
});

test('references are capped at the model’s limit of 10', () => {
    const refs = seedreamRefs(Array.from({ length: 14 }, () => ref()));
    assert.equal(refs.length, 10, 'over the cap the API rejects the whole request, losing the generation');
});

test('malformed or absent parts degrade to no references, never a throw', () => {
    for (const input of [null, undefined, 'parts', 42, {}]) assert.deepEqual(seedreamRefs(input), []);
    assert.deepEqual(seedreamRefs([null, {}, { inlineData: {} }, { inlineData: { data: '' } }]), [],
        'losing one bad reference beats failing the whole job');
});

// --- submit() body ------------------------------------------------------------

function stubArk() {
    const sent = [];
    globalThis.fetch = async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ data: [{ b64_json: 'out' }], usage: {} }), { status: 200 });
    };
    return sent;
}

const ROUTE = { category: 'image', provider_model_id: 'seedream-5-0-260128' };
const JOB = (parts) => ({
    request_body: {
        category: 'image', prompt: 'change the lamp in Image 1', parts,
        options: { aspectRatio: '1:1', imageSize: '2K' }, est_cost_usd: 0.03,
    },
});

let savedFetch;
test.beforeEach(() => { savedFetch = globalThis.fetch; });
test.afterEach(() => { globalThis.fetch = savedFetch; });

test('submit forwards references as `image` on the images/generations call', async () => {
    const sent = stubArk();
    await submit({ job: JOB([{ text: 'change the lamp in Image 1' }, ref(), ref('image/png')]), route: ROUTE, apiKey: 'k' });

    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /images\/generations$/);
    assert.equal(sent[0].body.image.length, 2, 'both references must reach the model');
    assert.ok(sent[0].body.image[0].startsWith('data:image/jpeg;base64,'));
    assert.equal(sent[0].body.prompt, 'change the lamp in Image 1');
});

test('submit omits `image` entirely when there are no references', async () => {
    const sent = stubArk();
    await submit({ job: JOB(undefined), route: ROUTE, apiKey: 'k' });
    assert.ok(!('image' in sent[0].body), 'an empty array is not the same as absent');
});

test('submit still strips the gateway metadata the API rejects', async () => {
    const sent = stubArk();
    await submit({ job: JOB([ref()]), route: ROUTE, apiKey: 'k' });
    for (const field of ['parts', 'options', 'category', 'est_cost_usd']) {
        assert.ok(!(field in sent[0].body), `${field} must not be forwarded`);
    }
    assert.deepEqual(
        Object.keys(sent[0].body).sort(),
        ['image', 'model', 'prompt', 'response_format', 'size', 'watermark'],
    );
});
