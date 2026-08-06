import test from 'node:test';
import assert from 'node:assert/strict';
import { modelUsageForQuotas } from '../lib/gateway/db.js';

test('modelUsageForQuotas returns numeric per-model spend and reservation totals', async () => {
    const calls = [];
    const sql = {
        query: async (query, params) => {
            calls.push({ query, params });
            return [
                { model_id: 'seedance', model_name: 'Seedance', used: '12.5', reserved: '2.25' },
                { model_id: 'seedream', model_name: 'Seedream', used: '3', reserved: '0' },
            ];
        },
    };
    const now = new Date('2026-08-06T12:00:00.000Z');
    const result = await modelUsageForQuotas(sql, [{
        id: 7, project_id: 42, user_id: null, model_id: null,
        type: 'usd', window: 'monthly',
    }], now);

    assert.deepEqual(result[7], [
        { model_id: 'seedance', model_name: 'Seedance', used: 12.5, reserved: 2.25 },
        { model_id: 'seedream', model_name: 'Seedream', used: 3, reserved: 0 },
    ]);
    assert.deepEqual(calls[0].params, ['2026-08-01T00:00:00.000Z', 42, null, null]);
    assert.match(calls[0].query, /GROUP BY x\.model_id, m\.display_name/);
    assert.match(calls[0].query, /NOT EXISTS/);
});
