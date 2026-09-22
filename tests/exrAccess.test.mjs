import test from 'node:test';
import assert from 'node:assert/strict';
import { publicExrAccess } from '../lib/byteplus/exrAccess.mjs';

test('EXR access is locked when no request exists', () => {
    assert.deepEqual(publicExrAccess(null, 7), {
        projectId: 7,
        requestId: null,
        status: 'locked',
        granted: false,
        expiresAt: null,
        requestedAt: null,
        decidedAt: null,
    });
});

test('pending EXR access stays locked until an admin approves it', () => {
    const access = publicExrAccess({ id: 3, project_id: 7, status: 'pending' }, 7);
    assert.equal(access.status, 'pending');
    assert.equal(access.granted, false);
});

test('approved EXR access is granted until its expiry', () => {
    const access = publicExrAccess({
        id: 3,
        project_id: 7,
        status: 'approved',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
    }, 7);
    assert.equal(access.status, 'approved');
    assert.equal(access.granted, true);
});

test('expired EXR access is locked again', () => {
    const access = publicExrAccess({
        id: 3,
        project_id: 7,
        status: 'approved',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
    }, 7);
    assert.equal(access.status, 'expired');
    assert.equal(access.granted, false);
});
