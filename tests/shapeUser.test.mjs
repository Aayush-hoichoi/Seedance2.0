import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeUser } from '../lib/auth/shape.mjs';

test('shapeUser maps a Clerk backend user to { userId, email, role }', () => {
    const u = {
        id: 'user_123',
        primaryEmailAddress: { emailAddress: 'a@hoichoi.tv' },
        emailAddresses: [{ emailAddress: 'b@hoichoi.tv' }],
        publicMetadata: { role: 'admin' },
    };
    assert.deepEqual(shapeUser(u), { userId: 'user_123', email: 'a@hoichoi.tv', role: 'admin' });
});

test('shapeUser falls back to first email and null role, and returns null for null', () => {
    const u = { id: 'user_9', emailAddresses: [{ emailAddress: 'x@y.z' }], publicMetadata: {} };
    assert.deepEqual(shapeUser(u), { userId: 'user_9', email: 'x@y.z', role: null });
    assert.equal(shapeUser(null), null);
});
