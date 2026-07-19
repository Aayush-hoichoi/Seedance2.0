import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAccess, hasPermission, isActive } from '../lib/gateway/access.mjs';

const NOW = new Date('2026-07-11T12:00:00Z');
const PAST = '2026-07-01T00:00:00Z';
const RECENT = '2026-07-11T11:00:00Z';
const FUTURE = '2026-08-01T00:00:00Z';

function decide(over = {}) {
    return effectiveAccess({
        modelId: 'seedance-2.0',
        now: NOW,
        overrides: [],
        grants: [],
        defaultModelIds: ['seedance-2.0-mini'],
        ...over,
    });
}

// --- precedence -------------------------------------------------------------

test('deny by default when no rule matches', () => {
    assert.deepEqual(decide(), { allowed: false, rule: 'deny_default' });
});

test('org-default model is allowed with no grants', () => {
    assert.deepEqual(decide({ modelId: 'seedance-2.0-mini' }), { allowed: true, rule: 'org_default', maxResolution: null });
});

test('project grant allows a non-default model', () => {
    assert.deepEqual(
        decide({ grants: [{ model_id: 'seedance-2.0' }] }),
        { allowed: true, rule: 'project_grant', maxResolution: null },
    );
});

test('user ALLOW override wins without a project grant', () => {
    assert.deepEqual(
        decide({ overrides: [{ model_id: 'seedance-2.0', effect: 'allow' }] }),
        { allowed: true, rule: 'allow_override', maxResolution: null },
    );
});

test('allow override carries its quality cap; other rules never cap', () => {
    assert.deepEqual(
        decide({ overrides: [{ model_id: 'seedance-2.0', effect: 'allow', max_resolution: '1080p' }] }),
        { allowed: true, rule: 'allow_override', maxResolution: '1080p' },
    );
});

test('user DENY override beats grant, allow override, and default', () => {
    assert.deepEqual(
        decide({
            modelId: 'seedance-2.0-mini',
            overrides: [
                { model_id: 'seedance-2.0-mini', effect: 'deny' },
                { model_id: 'seedance-2.0-mini', effect: 'allow' },
            ],
            grants: [{ model_id: 'seedance-2.0-mini' }],
        }),
        { allowed: false, rule: 'deny_override' },
    );
});

test('rules for other models never leak', () => {
    assert.equal(decide({ grants: [{ model_id: 'seedream-5.0-pro' }] }).allowed, false);
    assert.equal(decide({ overrides: [{ model_id: 'nano-banana-pro', effect: 'allow' }] }).allowed, false);
});

test('missing modelId denies', () => {
    assert.equal(decide({ modelId: null }).allowed, false);
});

// --- validity windows --------------------------------------------------------

test('expired grant falls through to deny', () => {
    assert.deepEqual(
        decide({ grants: [{ model_id: 'seedance-2.0', valid_until: RECENT }] }),
        { allowed: false, rule: 'deny_default' },
    );
});

test('windowed allow override caps only while active', () => {
    assert.equal(
        decide({ overrides: [{ model_id: 'seedance-2.0', effect: 'allow', max_resolution: '720p', valid_until: RECENT }] }).allowed,
        false,
    );
});

test('future-dated grant is not active yet', () => {
    assert.equal(decide({ grants: [{ model_id: 'seedance-2.0', valid_from: FUTURE }] }).allowed, false);
});

test('windowed grant active inside its window', () => {
    assert.equal(
        decide({ grants: [{ model_id: 'seedance-2.0', valid_from: PAST, valid_until: FUTURE }] }).allowed,
        true,
    );
});

test('revoked rows are inert', () => {
    assert.equal(decide({ grants: [{ model_id: 'seedance-2.0', revoked_at: RECENT }] }).allowed, false);
    assert.deepEqual(
        decide({
            overrides: [{ model_id: 'seedance-2.0', effect: 'deny', revoked_at: RECENT }],
            grants: [{ model_id: 'seedance-2.0' }],
        }),
        { allowed: true, rule: 'project_grant', maxResolution: null },
    );
});

test('expired DENY no longer blocks', () => {
    assert.equal(
        decide({
            overrides: [{ model_id: 'seedance-2.0', effect: 'deny', valid_until: RECENT }],
            grants: [{ model_id: 'seedance-2.0' }],
        }).allowed,
        true,
    );
});

test('isActive edge: valid_until is exclusive, valid_from inclusive', () => {
    assert.equal(isActive({ valid_until: NOW.toISOString() }, NOW), false);
    assert.equal(isActive({ valid_from: NOW.toISOString() }, NOW), true);
    assert.equal(isActive({}, NOW), true);
});

// --- permissions ---------------------------------------------------------------

const ROLE_PERMS = [
    { role_id: 'manager', permission_id: 'member.manage' },
    { role_id: 'manager', permission_id: 'quota.manage' },
    { role_id: 'viewer', permission_id: 'usage.view' },
];

test('hasPermission matches role rows only', () => {
    assert.equal(hasPermission('manager', 'member.manage', ROLE_PERMS), true);
    assert.equal(hasPermission('viewer', 'member.manage', ROLE_PERMS), false);
    assert.equal(hasPermission('member', 'usage.view', ROLE_PERMS), false);
    assert.equal(hasPermission(null, 'usage.view', ROLE_PERMS), false);
});
