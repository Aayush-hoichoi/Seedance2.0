import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUserAccessReport } from '../lib/gateway/userAccessReport.mjs';

const now = new Date('2026-10-06T00:00:00Z');
const models = [
    { id: 'seedance', display_name: 'Seedance', category: 'video', is_default: false },
    { id: 'imagen', display_name: 'Imagen', category: 'image', is_default: true },
];

test('member project: grant, deny override and org default all resolve', () => {
    const [p] = buildUserAccessReport({
        now,
        models,
        memberships: [{ project_id: 1, name: 'Alpha', paused: false, archived_at: null }],
        grants: [{ project_id: 1, model_id: 'seedance', revoked_at: null }],
        overrides: [{ project_id: 1, model_id: 'imagen', effect: 'deny', revoked_at: null }],
        spendRows: [],
    });
    const byModel = Object.fromEntries(p.access.map((a) => [a.model_id, a]));
    assert.equal(byModel.seedance.allowed, true);
    assert.equal(byModel.seedance.rule, 'project_grant');
    assert.equal(byModel.imagen.allowed, false); // deny override beats org default
    assert.equal(byModel.imagen.rule, 'deny_override');
});

test('spend in a left project shows as non-member with no access matrix', () => {
    const projects = buildUserAccessReport({
        now,
        models,
        memberships: [{ project_id: 1, name: 'Alpha', paused: false, archived_at: null }],
        grants: [],
        overrides: [],
        spendRows: [
            { project_id: 2, project_name: 'Old', model_id: 'seedance', cost_usd: 5, generations: 3, failures: 1 },
            { project_id: 1, project_name: 'Alpha', model_id: 'imagen', cost_usd: 2, generations: 4, failures: 0 },
        ],
    });
    assert.equal(projects.length, 2);
    assert.equal(projects[0].member, true); // members sort first
    const old = projects.find((p) => p.id === 2);
    assert.equal(old.member, false);
    assert.equal(old.access.length, 0);
    assert.equal(old.cost_usd, 5);
    assert.equal(projects.reduce((s, p) => s + p.cost_usd, 0), 7); // totals never drop former projects
});
