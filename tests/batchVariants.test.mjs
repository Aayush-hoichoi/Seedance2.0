import test from 'node:test';
import assert from 'node:assert/strict';
import { variantRole, collectVariantItems, itemsForOutput } from '../lib/seedance/batchVariants.mjs';

const vid = (name, extra = {}) => ({ kind: 'video', role: 'reference_video', url: `https://x/${name}`, name, ...extra });
const img = (name) => ({ kind: 'image', role: 'reference_image', url: `https://x/${name}`, name });

test('collectVariantItems: picks per-output videos, retargets the role, stamps the output', () => {
    const byRole = { [variantRole(1)]: [vid('b', { role: 'batch_variant_1' })] };
    const items = collectVariantItems(byRole, 'reference_video', 2);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, 'reference_video');
    assert.equal(items[0].batchVariant, 1);
    // No video slot, or batch ×1 → never any variants.
    assert.deepEqual(collectVariantItems(byRole, null, 2), []);
    assert.deepEqual(collectVariantItems(byRole, 'reference_video', 1), []);
});

test('itemsForOutput: output 0 keeps the shared refs, variant output swaps ONLY the primary video', () => {
    const shared = [img('i1'), vid('a'), vid('a2')];
    const all = [...shared, { ...vid('b'), batchVariant: 1 }];
    assert.deepEqual(itemsForOutput(all, 0), shared);
    const out1 = itemsForOutput(all, 1);
    assert.deepEqual(out1.map((m) => m.name), ['i1', 'b', 'a2']);
    assert.ok(out1.every((m) => m.batchVariant === undefined));
});

test('itemsForOutput: no shared video → the variant is appended', () => {
    const all = [img('i1'), { ...vid('b'), batchVariant: 1 }];
    assert.deepEqual(itemsForOutput(all, 1).map((m) => m.name), ['i1', 'b']);
    // An output without its own variant falls back to the shared refs.
    assert.deepEqual(itemsForOutput(all, 2).map((m) => m.name), ['i1']);
});
