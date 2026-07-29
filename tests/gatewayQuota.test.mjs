import test from 'node:test';
import assert from 'node:assert/strict';
import {
    windowBounds, applicableQuotas, unitsForType, evaluateQuotas, quotaBalances, thresholdsCrossed,
} from '../lib/gateway/quota.mjs';

const NOW = new Date('2026-07-11T15:30:00Z');

// --- windows ------------------------------------------------------------------

test('daily window spans the UTC day', () => {
    const { start, resetsAt } = windowBounds('daily', NOW);
    assert.equal(start.toISOString(), '2026-07-11T00:00:00.000Z');
    assert.equal(resetsAt.toISOString(), '2026-07-12T00:00:00.000Z');
});

test('monthly window spans the UTC month', () => {
    const { start, resetsAt } = windowBounds('monthly', NOW);
    assert.equal(start.toISOString(), '2026-07-01T00:00:00.000Z');
    assert.equal(resetsAt.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('lifetime window never resets', () => {
    const { start, resetsAt } = windowBounds('lifetime', NOW);
    assert.equal(start.getTime(), 0);
    assert.equal(resetsAt, null);
});

// --- scoping -------------------------------------------------------------------

const QUOTAS = [
    { id: 1, project_id: null, user_id: null, model_id: null, type: 'usd', window: 'monthly', hard_limit: 500, policy: 'hard', soft_overage_pct: 5 },
    { id: 2, project_id: 7, user_id: null, model_id: null, type: 'usd', window: 'monthly', hard_limit: 100, policy: 'hard', soft_overage_pct: 5 },
    { id: 3, project_id: 7, user_id: 'u1', model_id: null, type: 'usd', window: 'monthly', hard_limit: 50, policy: 'hard', soft_overage_pct: 5 },
    { id: 4, project_id: 9, user_id: null, model_id: null, type: 'usd', window: 'monthly', hard_limit: 10, policy: 'hard', soft_overage_pct: 5 },
    { id: 5, project_id: 7, user_id: 'u2', model_id: null, type: 'usd', window: 'monthly', hard_limit: 5, policy: 'hard', soft_overage_pct: 5, deleted_at: '2026-07-01' },
    { id: 6, project_id: 7, user_id: 'u1', model_id: 'seedance', type: 'usd', window: 'monthly', hard_limit: 20, policy: 'hard', soft_overage_pct: 5 },
    { id: 7, project_id: 7, user_id: 'u1', model_id: 'nano-banana', type: 'usd', window: 'monthly', hard_limit: 10, policy: 'hard', soft_overage_pct: 5 },
];

test('applicableQuotas layers workspace, project, user, and matching model scopes', () => {
    const ids = applicableQuotas(QUOTAS, { projectId: 7, userId: 'u1', modelId: 'seedance' }).map((q) => q.id);
    assert.deepEqual(ids.sort(), [1, 2, 3, 6]);
});

test('a model budget does not bind requests for another model', () => {
    const ids = applicableQuotas(QUOTAS, { projectId: 7, userId: 'u1', modelId: 'other-model' }).map((q) => q.id);
    assert.deepEqual(ids.sort(), [1, 2, 3]);
});

// --- unit mapping ------------------------------------------------------------------

test('unitsForType maps each quota type to its estimate units', () => {
    const est = { usd: 1.5, images: 30, video_seconds: 10, requests: 1 };
    assert.equal(unitsForType('usd', est), 1.5);
    assert.equal(unitsForType('credits', est), 1.5);
    assert.equal(unitsForType('image_count', est), 30);
    assert.equal(unitsForType('video_seconds', est), 10);
    assert.equal(unitsForType('request_count', est), 1);
});

// --- evaluation ------------------------------------------------------------------------

function evalWith({ used = {}, reserved = {}, estimate = { usd: 10 }, quotas = QUOTAS.slice(0, 3) } = {}) {
    return evaluateQuotas({
        quotas, projectId: 7, userId: 'u1', modelId: 'seedance', now: NOW, estimate,
        usedByQuota: used, reservedByQuota: reserved,
    });
}

test('a per-user per-model budget is enforced', () => {
    const r = evalWith({ quotas: [QUOTAS[5]], used: { 6: 15 } });
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].quota.id, 6);
});

test('quotaBalances reports the tightest effective USD headroom including reservations', () => {
    const rows = quotaBalances({
        quotas: QUOTAS,
        projectId: 7,
        userId: 'u1',
        modelId: 'seedance',
        usedByQuota: { 1: 100, 2: 40, 3: 45, 6: 12 },
        reservedByQuota: { 3: 2, 6: 1 },
    });
    assert.deepEqual(rows.map((r) => r.quota.id), [3, 6, 2, 1]);
    assert.equal(rows[0].remaining, 3);
    assert.equal(rows[0].used, 45);
    assert.equal(rows[0].reserved, 2);
});

test('passes when every layered limit has headroom', () => {
    const r = evalWith({ used: { 1: 100, 2: 50, 3: 10 } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
});

test('tightest limit binds first (user before project/org)', () => {
    const r = evalWith({ used: { 1: 100, 2: 50, 3: 45 } }); // 45+10 > 50
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].quota.id, 3);
    assert.equal(r.violations[0].resetsAt.toISOString(), '2026-08-01T00:00:00.000Z');
});

test('in-flight reservations count against the limit', () => {
    const r = evalWith({ used: { 3: 20 }, reserved: { 3: 25 } }); // 20+25+10 > 50
    assert.equal(r.ok, false);
    assert.equal(r.violations[0].quota.id, 3);
});

test('exactly reaching the limit still passes; exceeding fails', () => {
    assert.equal(evalWith({ used: { 3: 40 } }).ok, true);          // 40+10 = 50
    assert.equal(evalWith({ used: { 3: 40.01 } }).ok, false);      // just over
});

test('soft policy allows the overage percentage, then stops', () => {
    const soft = [{ id: 6, org_id: 'org_1', project_id: 7, user_id: null, type: 'usd', window: 'monthly', hard_limit: 100, policy: 'soft', soft_overage_pct: 5 }];
    assert.equal(evalWith({ quotas: soft, used: { 6: 95 } }).ok, true);   // 105 ceiling
    assert.equal(evalWith({ quotas: soft, used: { 6: 96 } }).ok, false);  // 106 > 105
});

test('quota types without estimate units do not bind', () => {
    const imgQuota = [{ id: 7, org_id: 'org_1', project_id: 7, user_id: null, type: 'image_count', window: 'daily', hard_limit: 10, policy: 'hard', soft_overage_pct: 5 }];
    const r = evalWith({ quotas: imgQuota, estimate: { usd: 3 } }); // video job: no images
    assert.equal(r.ok, true);
});

// --- alert thresholds ------------------------------------------------------------------------

test('thresholdsCrossed reports every threshold passed by this settlement', () => {
    const quota = { hard_limit: 100, alert_thresholds: [80, 90, 100] };
    assert.deepEqual(thresholdsCrossed(quota, 75, 92), [80, 90]);
    assert.deepEqual(thresholdsCrossed(quota, 92, 101), [100]);
    assert.deepEqual(thresholdsCrossed(quota, 50, 60), []);
    assert.deepEqual(thresholdsCrossed(quota, 80, 80), []); // no movement, no repeat
});
