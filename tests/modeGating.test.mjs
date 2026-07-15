import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, MODELS, modeAllowedForModel } from '../lib/seedance/constants.js';

const byKind = (kind) => MODELS.find((m) => m.kind === kind);
const mode = (id) => MODES.find((m) => m.id === id);

// BytePlus infers the task type from the content roles: reference_* items
// become an r2v task, which Seedance 1.5 Pro rejects (t2v/i2v/first+last only).
test('reference-based modes are blocked on Seedance 1.5 Pro', () => {
    for (const id of ['reference', 'motion_capture', 'green_screen', 'performance_transfer']) {
        assert.equal(modeAllowedForModel(mode(id), byKind('pro_1_5')), false, id);
    }
});

test('t2v, i2v and first+last stay allowed on Seedance 1.5 Pro', () => {
    for (const id of ['t2v', 'i2v_first', 'first_last']) {
        assert.equal(modeAllowedForModel(mode(id), byKind('pro_1_5')), true, id);
    }
});

test('the Seedance 2.0 family runs every mode', () => {
    for (const kind of ['full', 'fast', 'mini']) {
        for (const m of MODES) {
            assert.equal(modeAllowedForModel(m, byKind(kind)), true, `${kind}/${m.id}`);
        }
    }
});

test('missing mode or model never blocks', () => {
    assert.equal(modeAllowedForModel(null, byKind('pro_1_5')), true);
    assert.equal(modeAllowedForModel(mode('reference'), null), true);
});
