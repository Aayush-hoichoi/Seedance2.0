import test from 'node:test';
import assert from 'node:assert/strict';
import { usageRollup, userUsageWithModelBreakdown } from '../lib/gateway/usageQuery.js';

test('user_model usage groups each user spend by display model name', async () => {
    const calls = [];
    const expected = [{ key: 'admin@example.com', series: 'Seedance 2', cost_usd: 4.5 }];
    const sql = {
        query: async (query, params) => {
            calls.push({ query, params });
            return expected;
        },
    };

    const rows = await usageRollup(sql, {
        projectId: 15,
        groupBy: 'user_model',
        from: '2026-08-01T00:00:00.000Z',
    });

    assert.equal(rows, expected);
    assert.deepEqual(calls[0].params, [15, '2026-08-01T00:00:00.000Z', null]);
    assert.match(calls[0].query, /COALESCE\(u\.email, b\.user_id\) AS key/);
    assert.match(calls[0].query, /COALESCE\(m\.display_name, b\.model_id\) AS series/);
    assert.match(calls[0].query, /GROUP BY 1, 2/);
});

test('project usage keys by project name, never the raw id', async () => {
    const calls = [];
    const sql = { query: async (query, params) => { calls.push({ query, params }); return []; } };

    await usageRollup(sql, { groupBy: 'project' });
    assert.match(calls[0].query, /COALESCE\(p\.name, b\.project_id::text\) AS key/);
    assert.match(calls[0].query, /LEFT JOIN projects p ON p\.id = b\.project_id/);

    // The join is project-grouping only — other rollups must not pay for it.
    await usageRollup(sql, { groupBy: 'model' });
    assert.doesNotMatch(calls[1].query, /JOIN projects/);
});

test('userUsageWithModelBreakdown returns totals and nested model details together', async () => {
    const calls = [];
    const expected = [{
        key: 'admin@example.com',
        cost_usd: 7,
        model_breakdown: [
            { model_id: 'seedance', model_name: 'Seedance 2', cost_usd: 4.5 },
            { model_id: 'seedream', model_name: 'Seedream 5', cost_usd: 2.5 },
        ],
    }];
    const sql = {
        query: async (query, params) => {
            calls.push({ query, params });
            return expected;
        },
    };

    const rows = await userUsageWithModelBreakdown(sql, {
        projectId: 15,
        from: '2026-08-01T00:00:00.000Z',
    });

    assert.equal(rows, expected);
    assert.deepEqual(calls[0].params, [15, '2026-08-01T00:00:00.000Z', null]);
    assert.match(calls[0].query, /jsonb_agg\(jsonb_build_object/);
    assert.match(calls[0].query, /'model_name', model_name/);
    assert.match(calls[0].query, /SUM\(cost_usd\)::float8 AS cost_usd/);
});
