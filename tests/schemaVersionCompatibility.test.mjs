import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GATEWAY_DDL,
    SCHEMA_VERSION,
    shouldRunGatewaySchema,
} from '../lib/db/schema.mjs';

test('an older app never attempts to downgrade a newer database', () => {
    assert.equal(shouldRunGatewaySchema(18, 17), false);
    assert.equal(shouldRunGatewaySchema(17, 17), false);
    assert.equal(shouldRunGatewaySchema(16, 17), true);
    assert.equal(shouldRunGatewaySchema(undefined, 17), true);
});

test('schema v18 retains every appended production view column', () => {
    assert.ok(SCHEMA_VERSION >= 18);

    const gallery = GATEWAY_DDL.find((statement) => statement.startsWith('CREATE OR REPLACE VIEW gallery_generations'));
    const dataset = GATEWAY_DDL.find((statement) => statement.startsWith('CREATE OR REPLACE VIEW dataset_samples'));
    const ledger = GATEWAY_DDL.find((statement) => statement.startsWith('CREATE OR REPLACE VIEW generation_ledger'));

    assert.match(gallery, /j\.project_id/);
    assert.match(gallery, /AS style_look/);
    assert.match(gallery, /AS style_version/);

    assert.match(dataset, /AS sent_prompt/);
    assert.match(dataset, /g\.project_id/);
    assert.match(dataset, /g\.style_look/);
    assert.match(dataset, /g\.style_version/);

    assert.match(ledger, /j\.finished_at/);
    assert.match(ledger, /NULL::timestamptz\s+AS finished_at/);
});
