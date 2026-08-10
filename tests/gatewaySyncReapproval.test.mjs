import test from 'node:test';
import assert from 'node:assert/strict';
import { syncGatewayOverride } from '../lib/access/gatewaySync.mjs';

// Behavioural cover for the silent-approval bug: re-approving a grant whose
// override has already EXPIRED must push valid_until forward on the existing
// row. Production kept the request row and the override row in separate
// tables, so an approval that failed here still looked successful in the
// console while the user stayed locked out.

// Minimal stand-in for the neon tagged-template client: records every
// statement and replays canned rows in call order.
function fakeSql(responses) {
    const calls = [];
    const queue = [...responses];
    const sql = (strings, ...values) => {
        calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
        return Promise.resolve(queue.shift() ?? []);
    };
    sql.calls = calls;
    return sql;
}

const EXPIRED_GRANT_ROW = {
    id: 132,
    user_id: 'user_neha',
    user_email: 'neha@example.com',
    model_id: 'dreamina-seedance-2-0-260128', // requests store the provider version tag
    project_id: 12,
    max_resolution: '1080p',
};
const ADMIN = { userId: 'user_admin', email: 'admin@example.com' };
const NEW_EXPIRY = '2026-08-09T07:23:00.000Z';

function runApproval() {
    const sql = fakeSql([
        [{ model_id: 'seedance-2.0' }], // version tag → alias
        [{ id: 91 }],                   // the upsert
    ]);
    return syncGatewayOverride({ action: 'approve', row: EXPIRED_GRANT_ROW, admin: ADMIN, validUntil: NEW_EXPIRY, sql })
        .then(() => sql);
}

test('re-approving an expired grant upserts the override with the new expiry', async () => {
    const sql = await runApproval();
    const upsert = sql.calls.find((c) => c.text.includes('INSERT INTO user_model_overrides'));
    assert.ok(upsert, 'approval must write the override the gateway enforces');

    // The whole bug: a bare column list cannot infer a partial unique index,
    // so this threw and the grant was never applied.
    assert.match(upsert.text, /ON CONFLICT \(project_id, user_id, model_id\) WHERE source_request_id IS NULL/);
    assert.match(upsert.text, /DO UPDATE SET/, 'an existing expired row must be updated, not skipped');
    assert.match(upsert.text, /valid_until = EXCLUDED\.valid_until/, 'the stale expiry must be overwritten');
    assert.match(upsert.text, /revoked_at = NULL/, 'a previously revoked grant must come back');

    // The new expiry must actually be bound — an upsert that reuses the old
    // value would leave the user just as locked out.
    assert.ok(upsert.values.includes(NEW_EXPIRY), `new expiry must be bound, got ${JSON.stringify(upsert.values)}`);
});

test('the grant resolves the provider version tag to the model alias the gateway keys on', async () => {
    const sql = await runApproval();
    const upsert = sql.calls.find((c) => c.text.includes('INSERT INTO user_model_overrides'));
    assert.ok(upsert.values.includes('seedance-2.0'),
        'overrides key by alias; storing the version tag would grant access to nothing');
    assert.ok(!upsert.values.includes('dreamina-seedance-2-0-260128'));
});

test('an approval records the audit trail and access event', async () => {
    const sql = await runApproval();
    assert.ok(sql.calls.some((c) => c.text.includes('INSERT INTO audit_log')), 'approval must be auditable');
    assert.ok(sql.calls.some((c) => c.text.includes('INSERT INTO events')), 'approval must emit access.granted');
});

test('a failing upsert propagates so callers cannot report a phantom grant', async () => {
    const boom = new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification');
    const sql = (strings) => (strings.join('').includes('INSERT INTO user_model_overrides')
        ? Promise.reject(boom)
        : Promise.resolve([{ model_id: 'seedance-2.0' }]));

    await assert.rejects(
        () => syncGatewayOverride({ action: 'approve', row: EXPIRED_GRANT_ROW, admin: ADMIN, validUntil: NEW_EXPIRY, sql }),
        /ON CONFLICT/,
        'swallowing this is what hid the outage for four days',
    );
});
