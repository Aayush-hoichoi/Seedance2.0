import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GATEWAY_DDL } from '../lib/db/schema.mjs';

// Regression guard for the silent-approval bug: production replaced the plain
// UNIQUE (project_id, user_id, model_id) on user_model_overrides with PARTIAL
// unique indexes, but gatewaySync's upsert still arbitrated on the bare column
// list. Postgres cannot infer a partial index without a matching predicate, so
// every approve threw and the enforcing override was never written — while the
// request row still flipped to "approved" in the console.
//
// These two must stay in lockstep: the arbiter predicate in the upsert and the
// predicate on the index it is meant to resolve to.
const sync = readFileSync(new URL('../lib/access/gatewaySync.mjs', import.meta.url), 'utf8');

test('the approve upsert arbitrates on a partial index that the schema declares', () => {
    const onConflict = sync.match(/ON CONFLICT \(([^)]*)\)\s*(WHERE [^\n]*?)?\s*\n\s*DO UPDATE/);
    assert.ok(onConflict, 'gatewaySync must still upsert the override on approve');

    const columns = onConflict[1].split(',').map((c) => c.trim());
    const predicate = (onConflict[2] || '').trim();
    assert.deepEqual(columns, ['project_id', 'user_id', 'model_id']);
    assert.equal(predicate, 'WHERE source_request_id IS NULL',
        'a bare column list cannot infer a partial unique index — the predicate is required');

    const index = GATEWAY_DDL.find((s) => s.includes('user_model_overrides_manual_scope_uidx'));
    assert.ok(index, 'the arbiter index must be created by the automatic schema chain');
    assert.match(index, /CREATE UNIQUE INDEX/);
    assert.match(index, /\(project_id, user_id, model_id\)/);
    assert.match(index, /WHERE source_request_id IS NULL/);
});

test('schema declares the source_request_id column the partial indexes split on', () => {
    const column = GATEWAY_DDL.find((s) => /ALTER TABLE user_model_overrides ADD COLUMN IF NOT EXISTS source_request_id/.test(s));
    assert.ok(column, 'the partial indexes are unbuildable without this column');

    // The old whole-table UNIQUE must be gone in both directions: dropped on
    // existing databases, and never created on a fresh one. Otherwise a new
    // deployment gets a constraint production does not have.
    const drop = GATEWAY_DDL.find((s) => /DROP CONSTRAINT IF EXISTS user_model_overrides_project_id_user_id_model_id_key/.test(s));
    assert.ok(drop, 'existing databases must shed the old whole-table UNIQUE');

    const create = GATEWAY_DDL.find((s) => /CREATE TABLE IF NOT EXISTS user_model_overrides/.test(s));
    assert.doesNotMatch(create, /UNIQUE \(project_id, user_id, model_id\)/,
        'a fresh database must not re-create the constraint the migration drops');
});

test('DDL order: the column and the drop precede the indexes that depend on them', () => {
    const at = (needle) => GATEWAY_DDL.findIndex((s) => s.includes(needle));
    assert.ok(at('ADD COLUMN IF NOT EXISTS source_request_id') < at('user_model_overrides_manual_scope_uidx'));
    assert.ok(at('DROP CONSTRAINT IF EXISTS user_model_overrides_project_id_user_id_model_id_key')
        < at('user_model_overrides_manual_scope_uidx'));
});
