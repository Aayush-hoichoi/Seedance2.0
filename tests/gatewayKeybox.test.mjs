import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, keyLast4 } from '../lib/gateway/keybox.mjs';

const KEK = 'unit-test-key-encryption-secret';

test('roundtrip: decrypt(encrypt(x)) === x', () => {
    const ct = encryptSecret('sk-abc123XYZ', KEK);
    assert.notEqual(ct, 'sk-abc123XYZ');
    assert.equal(decryptSecret(ct, KEK), 'sk-abc123XYZ');
});

test('ciphertexts are salted (same input, different output)', () => {
    assert.notEqual(encryptSecret('same', KEK), encryptSecret('same', KEK));
});

test('wrong key or tampered ciphertext fails closed (null)', () => {
    const ct = encryptSecret('secret', KEK);
    assert.equal(decryptSecret(ct, 'other-key'), null);
    assert.equal(decryptSecret(ct.slice(0, -4) + 'AAAA', KEK), null);
    assert.equal(decryptSecret('garbage', KEK), null);
});

test('empty inputs are rejected', () => {
    assert.throws(() => encryptSecret('', KEK));
    assert.throws(() => encryptSecret('x', ''));
});

test('keyLast4 exposes only the tail for display', () => {
    assert.equal(keyLast4('sk-abc123XYZ9'), 'XYZ9');
    assert.equal(keyLast4('abc'), '***');
});
