import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresInitialModelBudget } from '../lib/gateway/initialModelBudget.mjs';

test('the three restricted Seedance tiers require an individual initial budget', () => {
    for (const id of ['seedance-2.0', 'seedance-2.5', 'seedance-2.0-sensitive']) {
        assert.equal(requiresInitialModelBudget(id), true, id);
    }
    assert.equal(requiresInitialModelBudget('seedance-2.0-mini'), false);
});
