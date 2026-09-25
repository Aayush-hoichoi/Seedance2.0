import test from 'node:test';
import assert from 'node:assert/strict';
import { groupProjectBudgets, projectOverallBudget } from '../app/console/projects/projectBudgetGroups.mjs';

const members = [
    { user_id: 'u_neha', email: 'neha@example.com' },
    { user_id: 'u_raktim', email: 'raktim@example.com' },
];

test('one group per user, shared pool first, "all models" row leading', () => {
    const groups = groupProjectBudgets({
        quotas: [
            { id: 1, user_id: 'u_neha', model_id: 'seedance-2.5', used: 74 },
            { id: 2, user_id: 'u_neha', model_id: null, used: 385 },
            { id: 3, user_id: 'u_neha', model_id: 'seedance-2.0', used: 236 },
            { id: 4, user_id: null, model_id: null, used: 900 },
        ],
        spendRows: [{ key: 'neha@example.com', cost_usd: 385.25 }],
        members,
    });
    assert.equal(groups.length, 2);
    assert.equal(groups[0].userId, null); // shared pool card first
    assert.equal(groups[0].spentUsd, 385.25); // shared card shows total project spend
    assert.deepEqual(groups[1].rows.map((q) => q.id), [2, 3, 1]); // overall, then models by spend
    assert.equal(groups[1].spentUsd, 385.25);
});

test('member with spend but no budget still gets an (empty) group', () => {
    const groups = groupProjectBudgets({
        quotas: [],
        spendRows: [{ key: 'raktim@example.com', cost_usd: 6.45 }],
        members,
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].userId, 'u_raktim');
    assert.deepEqual(groups[0].rows, []);
    assert.equal(groups[0].spentUsd, 6.45);
});

test('users sort by spend; spend rows keyed by raw user id still match', () => {
    const groups = groupProjectBudgets({
        quotas: [
            { id: 1, user_id: 'u_neha', model_id: null, used: 1 },
            { id: 2, user_id: 'u_gone', model_id: null, used: 2 },
        ],
        spendRows: [
            { key: 'neha@example.com', cost_usd: 10 },
            { key: 'u_gone', cost_usd: 50 }, // deleted user: rollup falls back to the id
        ],
        members,
    });
    assert.deepEqual(groups.map((g) => g.userId), ['u_gone', 'u_neha']);
    assert.equal(groups[0].spentUsd, 50);
});

test('allotted: "all models" cap wins, else per-model caps add up; non-usd ignored', () => {
    const groups = groupProjectBudgets({
        quotas: [
            { id: 1, user_id: 'u_neha', model_id: null, type: 'usd', hard_limit: '472', used: 0 },
            { id: 2, user_id: 'u_neha', model_id: 'seedance-2.0', type: 'usd', hard_limit: '343', used: 0 },
            { id: 3, user_id: 'u_raktim', model_id: 'seedance-2.0', type: 'usd', hard_limit: '30', used: 0 },
            { id: 4, user_id: 'u_raktim', model_id: 'nano-banana', type: 'usd', hard_limit: '10', used: 0 },
            { id: 5, user_id: 'u_raktim', model_id: null, type: 'video_seconds', hard_limit: '600', used: 0 },
        ],
        spendRows: [],
        members,
    });
    const neha = groups.find((g) => g.userId === 'u_neha');
    const raktim = groups.find((g) => g.userId === 'u_raktim');
    assert.equal(neha.allottedUsd, 472); // overall cap covers the sub-cap
    assert.equal(raktim.allottedUsd, 40); // no overall: model caps add up, seconds ignored
});

test('in-flight follows the same rule: overall reservation wins, else model rows add up', () => {
    const groups = groupProjectBudgets({
        quotas: [
            { id: 1, user_id: 'u_neha', model_id: null, type: 'usd', hard_limit: '100', used: 0, reserved: 5 },
            { id: 2, user_id: 'u_neha', model_id: 'a', type: 'usd', hard_limit: '50', used: 0, reserved: 5 },
            { id: 3, user_id: 'u_raktim', model_id: 'a', type: 'usd', hard_limit: '10', used: 0, reserved: 2 },
            { id: 4, user_id: 'u_raktim', model_id: 'b', type: 'usd', hard_limit: '10', used: 0, reserved: 3 },
        ],
        spendRows: [],
        members,
    });
    assert.equal(groups.find((g) => g.userId === 'u_neha').reservedUsd, 5); // not 10
    assert.equal(groups.find((g) => g.userId === 'u_raktim').reservedUsd, 5);
});

test('every used model gets a row: spent-but-unbudgeted models surface with the overall cap', () => {
    const groups = groupProjectBudgets({
        quotas: [
            { id: 1, user_id: 'u_neha', model_id: null, type: 'usd', hard_limit: '614', used: 599.5 },
            { id: 2, user_id: 'u_neha', model_id: 'seedance-2.0', type: 'usd', hard_limit: '620', used: 583.06 },
        ],
        spendRows: [{
            key: 'neha@example.com',
            cost_usd: 599.5053,
            model_breakdown: [
                { model_id: 'seedance-2.0', model_name: 'Seedance 2.0', cost_usd: 583.0569 },
                { model_id: 'seedance-2.5', model_name: 'Seedance 2.5', cost_usd: 16.2084 },
            ],
        }],
        members,
    });
    const neha = groups.find((g) => g.userId === 'u_neha');
    // seedance-2.0 already has its own row; 2.5 must surface, scaled to the overall cap.
    assert.deepEqual(neha.unbudgeted.map((m) => m.model_id), ['seedance-2.5']);
    assert.equal(neha.overallCapUsd, 614);
});

test('spend breakdown: per user from their row, merged across users for Everyone', () => {
    const groups = groupProjectBudgets({
        quotas: [{ id: 1, user_id: null, model_id: 'a', type: 'usd', hard_limit: '100', used: 9 }],
        spendRows: [
            { key: 'neha@example.com', cost_usd: 6, model_breakdown: [{ model_id: 'a', model_name: 'A', cost_usd: 6 }] },
            { key: 'raktim@example.com', cost_usd: 3, model_breakdown: [{ model_id: 'a', model_name: 'A', cost_usd: 1 }, { model_id: 'b', model_name: 'B', cost_usd: 2 }] },
        ],
        members,
    });
    const everyone = groups.find((g) => g.userId === null);
    assert.deepEqual(everyone.spendBreakdown, [
        { model_id: 'a', model_name: 'A', cost_usd: 7 },
        { model_id: 'b', model_name: 'B', cost_usd: 2 },
    ]);
    const neha = groups.find((g) => g.userId === 'u_neha');
    assert.deepEqual(neha.spendBreakdown.map((m) => m.model_id), ['a']);
});

test('overall budget: cap, project-wide spend, and what members already hold', () => {
    const overall = projectOverallBudget({
        quotas: [
            { id: 1, user_id: null, model_id: null, type: 'usd', hard_limit: '1000', used: 240, reserved: 15 },
            { id: 2, user_id: 'u_neha', model_id: 'seedance-2.0', type: 'usd', hard_limit: '300' },
            { id: 3, user_id: 'u_raktim', model_id: 'nano-banana', type: 'usd', hard_limit: '150' },
            { id: 4, user_id: null, model_id: 'nano-banana', type: 'usd', hard_limit: '400' }, // sub-cap, not an allocation
            { id: 5, user_id: 'u_raktim', model_id: null, type: 'video_seconds', hard_limit: '600' }, // other unit
        ],
        spendRows: [{ key: 'neha@example.com', cost_usd: 240 }],
    });
    assert.equal(overall.capUsd, 1000);
    assert.equal(overall.spentUsd, 240);
    assert.equal(overall.reservedUsd, 15);
    assert.equal(overall.allocatedUsd, 450); // only the member dollar budgets
});

test('overall budget: with no cap the project is uncapped and spend is rolled up', () => {
    const overall = projectOverallBudget({
        quotas: [{ id: 1, user_id: 'u_neha', model_id: 'a', type: 'usd', hard_limit: '50' }],
        spendRows: [{ key: 'neha@example.com', cost_usd: 6 }, { key: 'raktim@example.com', cost_usd: 3 }],
    });
    assert.equal(overall.quota, null);
    assert.equal(overall.capUsd, null); // null = unlimited, not zero
    assert.equal(overall.spentUsd, 9);
    assert.equal(overall.allocatedUsd, 50);
});

test('the overall budget is not repeated as a row inside the shared-pool group', () => {
    const quotas = [
        { id: 1, user_id: null, model_id: null, type: 'usd', hard_limit: '1000', used: 0 },
        { id: 2, user_id: null, model_id: 'a', type: 'usd', hard_limit: '400', used: 0 },
    ];
    const groups = groupProjectBudgets({ quotas, spendRows: [], members });
    assert.deepEqual(groups.find((g) => g.userId === null).rows.map((q) => q.id), [2]);
    assert.equal(projectOverallBudget({ quotas, spendRows: [] }).quota.id, 1);
});
