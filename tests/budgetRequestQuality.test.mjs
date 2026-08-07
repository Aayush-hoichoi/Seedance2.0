import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityCap } from '../lib/budgetRequests.mjs';

test('all-model quality levels map onto each model ladder', () => {
    assert.equal(qualityCap('seedance-2.0', 'standard'), '480p');
    assert.equal(qualityCap('seedance-2.0', 'high'), '1080p');
    assert.equal(qualityCap('seedance-2.0', 'maximum'), '4k');
    assert.equal(qualityCap('nano-banana-pro', 'standard'), '1K');
    assert.equal(qualityCap('nano-banana-pro', 'high'), '2K');
    assert.equal(qualityCap('nano-banana-pro', 'maximum'), '4K');
});

test('a concrete requested tier is canonicalized and unsupported tiers reject', () => {
    assert.equal(qualityCap('seedance-2.0', '4K'), '4k');
    assert.equal(qualityCap('seedance-2.0-fast', '1080p'), null);
});
