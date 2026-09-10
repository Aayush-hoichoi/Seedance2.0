import test from 'node:test';
import assert from 'node:assert/strict';
import { packDraft, mergeDraft, unpackDraft, DRAFT_VERSION } from '../lib/seedance/draftMemory.mjs';

// Mirror a mode's slot shape without importing the ESM constants.
const MODE = {
    media: [
        { role: 'first_frame', kind: 'image', max: 1 },
        { role: 'reference_images', kind: 'image', max: 4 },
        { role: 'video', kind: 'video', max: 1 },
    ],
};

const vref = (over = {}) => ({
    kind: 'image', role: 'reference_images', url: 'asset://abc', previewUrl: 'https://cdn/x.jpg',
    name: 'x.jpg', assetId: 'abc', tosKey: 'tos/x.jpg', isImage: true, ...over,
});
const iref = (b64, name = 'a.jpg') => ({ mimeType: 'image/jpeg', b64, name, previewUrl: `data:image/jpeg;base64,${b64}` });

const store = (projectId, draft) => mergeDraft(null, projectId, packDraft(draft));
const roundTrip = (projectId, draft, opts = {}) =>
    unpackDraft(store(projectId, draft), projectId, { mode: MODE, imageRefMax: 14, ...opts });

test('prompt and video-mode references survive a round trip', () => {
    const d = roundTrip(7, {
        prompt: 'a slow dolly through neon',
        mediaByRole: { reference_images: [vref()], video: [vref({ kind: 'video', role: 'video', isImage: false })] },
    });
    assert.equal(d.prompt, 'a slow dolly through neon');
    assert.equal(d.mediaByRole.reference_images.length, 1);
    assert.equal(d.mediaByRole.reference_images[0].tosKey, 'tos/x.jpg'); // lets a stale asset:// re-source
    assert.equal(d.mediaByRole.video.length, 1);
    assert.equal(d.imageRefs.length, 0);
});

test('unstorable references are dropped, not the draft around them', () => {
    const d = roundTrip(7, {
        prompt: 'keep me',
        mediaByRole: {
            reference_images: [
                { ...vref(), pending: true },              // still uploading
                { ...vref(), url: 'data:image/jpeg;base64,AAA' }, // local blob, unresolvable later
                vref({ name: 'good.jpg' }),
            ],
        },
    });
    assert.equal(d.prompt, 'keep me');
    assert.equal(d.mediaByRole.reference_images.length, 1);
    assert.equal(d.mediaByRole.reference_images[0].name, 'good.jpg');
});

test('a data: previewUrl is dropped while its durable url is kept', () => {
    const d = roundTrip(7, { prompt: 'p', mediaByRole: { reference_images: [vref({ previewUrl: 'data:image/jpeg;base64,AAA' })] } });
    assert.equal(d.mediaByRole.reference_images[0].previewUrl, null);
    assert.equal(d.mediaByRole.reference_images[0].url, 'asset://abc');
});

test('references land clamped to the live slot, and vanished slots are skipped', () => {
    const d = roundTrip(7, {
        prompt: 'p',
        mediaByRole: {
            reference_images: [vref(), vref(), vref(), vref(), vref(), vref()], // 6 into a max of 4
            gone: [vref({ role: 'gone' })],                                     // slot no longer exists
        },
    });
    assert.equal(d.mediaByRole.reference_images.length, 4);
    assert.equal(d.mediaByRole.gone, undefined);
});

test('inline image refs rebuild their preview and honour the live per-model cap', () => {
    const draft = { prompt: '', imageRefs: [iref('AAAA', 'a.jpg'), iref('BBBB', 'b.jpg'), iref('CCCC', 'c.jpg')] };
    const all = roundTrip(7, draft);
    assert.equal(all.imageRefs.length, 3);
    assert.equal(all.imageRefs[0].previewUrl, 'data:image/jpeg;base64,AAAA'); // not stored; rebuilt
    // Settings restore landed on Flash (3 refs) → a Pro-sized draft is trimmed.
    const capped = roundTrip(7, draft, { imageRefMax: 2 });
    assert.equal(capped.imageRefs.length, 2);
});

test('inline image refs stop at the byte budget instead of throwing the draft away', () => {
    const big = 'x'.repeat(900_000); // ~0.9MB of base64 each; budget is 2MB
    const d = roundTrip(7, { prompt: 'p', imageRefs: [iref(big, '1'), iref(big, '2'), iref(big, '3')] });
    assert.equal(d.imageRefs.length, 2);
    assert.equal(d.prompt, 'p');
});

test('drafts are scoped per project', () => {
    const map = mergeDraft(store(7, { prompt: 'seven' }), 9, packDraft({ prompt: 'nine' }));
    assert.equal(unpackDraft(map, 7, { mode: MODE }).prompt, 'seven');
    assert.equal(unpackDraft(map, 9, { mode: MODE }).prompt, 'nine');
    assert.equal(unpackDraft(map, 12, { mode: MODE }), null); // untouched project opens blank
});

test('an empty bar stores nothing and clears the project entry', () => {
    assert.equal(packDraft({ prompt: '   ', mediaByRole: {}, imageRefs: [] }), null);
    const cleared = mergeDraft(store(7, { prompt: 'seven' }), 7, null);
    assert.deepEqual(cleared.byProject, {});
});

test('a stored entry from another version is ignored outright', () => {
    const map = store(7, { prompt: 'seven' });
    assert.equal(unpackDraft({ ...map, v: DRAFT_VERSION + 1 }, 7, { mode: MODE }), null);
    assert.equal(unpackDraft(null, 7, { mode: MODE }), null);
    assert.equal(unpackDraft('nope', 7, { mode: MODE }), null);
});

test('the map prunes stale entries and keeps only the newest projects', () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const withStale = mergeDraft(null, 1, packDraft({ prompt: 'old', now: old }));
    assert.deepEqual(mergeDraft(withStale, 2, packDraft({ prompt: 'new' })).byProject[1], undefined);

    let map = null;
    for (let i = 1; i <= 10; i++) map = mergeDraft(map, i, packDraft({ prompt: `p${i}`, now: Date.now() + i }));
    assert.equal(Object.keys(map.byProject).length, 8);
    assert.equal(map.byProject[1], undefined);  // oldest two evicted
    assert.equal(map.byProject[10].prompt, 'p10');
});

test('a null project id gets its own bucket rather than colliding', () => {
    const map = mergeDraft(store(null, { prompt: 'no gateway' }), 7, packDraft({ prompt: 'seven' }));
    assert.equal(unpackDraft(map, null, { mode: MODE }).prompt, 'no gateway');
    assert.equal(unpackDraft(map, 7, { mode: MODE }).prompt, 'seven');
});
