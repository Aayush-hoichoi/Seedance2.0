import test from 'node:test';
import assert from 'node:assert/strict';
import { userFromClerkEvent } from '../lib/access/clerkUser.mjs';

test('picks the primary email, full name, role, and created_at', () => {
    const out = userFromClerkEvent({
        id: 'u1',
        email_addresses: [
            { id: 'e1', email_address: 'old@x.com' },
            { id: 'e2', email_address: 'primary@x.com' },
        ],
        primary_email_address_id: 'e2',
        first_name: 'Ann',
        last_name: 'Lee',
        public_metadata: { role: 'admin' },
        created_at: 1700000000000,
    });
    assert.deepEqual(out, { id: 'u1', email: 'primary@x.com', name: 'Ann Lee', role: 'admin', createdAtMs: 1700000000000 });
});

test('falls back to the first email when no primary match', () => {
    const out = userFromClerkEvent({
        id: 'u2',
        email_addresses: [{ id: 'e1', email_address: 'first@x.com' }],
        primary_email_address_id: 'missing',
        first_name: 'Bo',
    });
    assert.equal(out.email, 'first@x.com');
    assert.equal(out.name, 'Bo');
    assert.equal(out.role, null);
    assert.equal(out.createdAtMs, null);
});

test('handles no emails / no name gracefully', () => {
    const out = userFromClerkEvent({ id: 'u3', email_addresses: [] });
    assert.equal(out.email, null);
    assert.equal(out.name, null);
});

test('returns null for missing data or id', () => {
    assert.equal(userFromClerkEvent(null), null);
    assert.equal(userFromClerkEvent({}), null);
});
