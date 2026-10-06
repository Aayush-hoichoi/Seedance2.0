import test from 'node:test';
import assert from 'node:assert/strict';
import { variantRole, variantSlotFor, collectVariantItems, itemsForOutput, imageRefsForOutput } from '../lib/seedance/batchVariants.mjs';

const vid = (name, extra = {}) => ({ kind: 'video', role: 'reference_video', url: `https://x/${name}`, name, ...extra });
const img = (name, role = 'reference_image') => ({ kind: 'image', role, url: `https://x/${name}`, name });

test('variantSlotFor: video slot first, else first_frame, none for t2v / autoMannequin', () => {
    const multiRef = { media: [{ kind: 'image', role: 'reference_image' }, { kind: 'video', role: 'reference_video' }] };
    assert.equal(variantSlotFor(multiRef).role, 'reference_video');
    const i2v = { media: [{ kind: 'image', role: 'first_frame' }] };
    assert.equal(variantSlotFor(i2v).role, 'first_frame');
    const firstLast = { media: [{ kind: 'image', role: 'first_frame' }, { kind: 'image', role: 'last_frame' }] };
    assert.equal(variantSlotFor(firstLast).role, 'first_frame');
    assert.equal(variantSlotFor({ media: [] }), null);
    assert.equal(variantSlotFor({ autoMannequin: true, media: [{ kind: 'video', role: 'reference_video' }] }), null);
});

test('collectVariantItems: picks per-output refs, retargets the role, stamps the output', () => {
    const byRole = { [variantRole(1)]: [vid('b', { role: 'batch_variant_1' })] };
    const items = collectVariantItems(byRole, 'reference_video', 2);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, 'reference_video');
    assert.equal(items[0].batchVariant, 1);
    // No target slot, or batch ×1 → never any variants.
    assert.deepEqual(collectVariantItems(byRole, null, 2), []);
    assert.deepEqual(collectVariantItems(byRole, 'reference_video', 1), []);
});

test('itemsForOutput: output 0 keeps the shared refs, variant output swaps ONLY the primary of its role', () => {
    const shared = [img('i1'), vid('a'), vid('a2')];
    const all = [...shared, { ...vid('b'), batchVariant: 1 }];
    assert.deepEqual(itemsForOutput(all, 0), shared);
    const out1 = itemsForOutput(all, 1);
    assert.deepEqual(out1.map((m) => m.name), ['i1', 'b', 'a2']);
    assert.ok(out1.every((m) => m.batchVariant === undefined));
});

test('itemsForOutput: image variant swaps first_frame, leaves last_frame alone', () => {
    const shared = [img('first', 'first_frame'), img('last', 'last_frame')];
    const all = [...shared, { ...img('swap', 'first_frame'), batchVariant: 1 }];
    assert.deepEqual(itemsForOutput(all, 1).map((m) => m.name), ['swap', 'last']);
});

test('itemsForOutput: no shared item of the role → the variant is appended', () => {
    const all = [img('i1'), { ...vid('b'), batchVariant: 1 }];
    assert.deepEqual(itemsForOutput(all, 1).map((m) => m.name), ['i1', 'b']);
    // An output without its own variant falls back to the shared refs.
    assert.deepEqual(itemsForOutput(all, 2).map((m) => m.name), ['i1']);
});

test('imageRefsForOutput: variant replaces the first ref, or stands alone', () => {
    const refs = [{ name: 'r1' }, { name: 'r2' }];
    const variants = { 1: { name: 'v' } };
    assert.deepEqual(imageRefsForOutput(refs, variants, 0).map((r) => r.name), ['r1', 'r2']);
    assert.deepEqual(imageRefsForOutput(refs, variants, 1).map((r) => r.name), ['v', 'r2']);
    assert.deepEqual(imageRefsForOutput([], variants, 1).map((r) => r.name), ['v']);
    assert.deepEqual(imageRefsForOutput(refs, {}, 1).map((r) => r.name), ['r1', 'r2']);
});
