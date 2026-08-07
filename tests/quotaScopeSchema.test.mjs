import test from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_DDL, SCHEMA_VERSION } from '../lib/db/schema.mjs';

test('schema v10 consolidates duplicate active quota scopes before enforcing uniqueness', () => {
    // Landed in v10 and must stay in the chain — pinning the exact number here
    // just breaks this test on every unrelated bump.
    assert.ok(SCHEMA_VERSION >= 10, 'the quota-scope migration ships from v10 onward');
    const migration = GATEWAY_DDL.find((statement) => statement.includes('quotas_unique_active_scope'));
    assert.ok(migration, 'quota-scope migration must be part of the automatic schema chain');

    const lockAt = migration.indexOf('LOCK TABLE quotas');
    const cleanupAt = migration.indexOf('ranked_active_quotas');
    const indexAt = migration.indexOf('CREATE UNIQUE INDEX quotas_unique_active_scope');
    assert.ok(lockAt >= 0 && lockAt < cleanupAt, 'writes must be locked before duplicate cleanup');
    assert.ok(cleanupAt < indexAt, 'duplicates must be soft-deleted before index creation');
    assert.match(migration, /WHERE deleted_at IS NULL/);
    assert.match(migration, /COALESCE\(project_id, -1\)/);
    assert.match(migration, /COALESCE\(user_id, ''\)/);
    assert.match(migration, /COALESCE\(model_id, ''\)/);
});

