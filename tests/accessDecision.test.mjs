import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseModel } from '../lib/access/decision.mjs';

const GATED = ['full-2-0'];

test('open model is always allowed', () => {
    assert.equal(canUseModel({ modelId: 'mini', gatedModelIds: GATED, approvedModelIds: [] }), true);
});

test('gated model denied without a grant', () => {
    assert.equal(canUseModel({ modelId: 'full-2-0', gatedModelIds: GATED, approvedModelIds: [] }), false);
});

test('gated model allowed with a grant', () => {
    assert.equal(canUseModel({ modelId: 'full-2-0', gatedModelIds: GATED, approvedModelIds: ['full-2-0'] }), true);
});

test('missing / unknown modelId denied', () => {
    assert.equal(canUseModel({ modelId: '', gatedModelIds: GATED, approvedModelIds: [] }), false);
    assert.equal(canUseModel({ modelId: undefined, gatedModelIds: GATED, approvedModelIds: [] }), false);
});
