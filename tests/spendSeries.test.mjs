import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserSpendSeries, OTHERS } from '../app/console/spendSeries.mjs';

const row = (key, series, cost) => ({ key, series, cost_usd: cost });

test('pivots (day, user) rows into one object per day, zero-filling gaps', () => {
    const { data, series } = buildUserSpendSeries([
        row('2026-07-01', 'a@x.com', 1),
        row('2026-07-02', 'b@x.com', 2),
        row('2026-07-02', 'a@x.com', 3),
    ]);
    assert.deepEqual(series.sort(), ['a@x.com', 'b@x.com']);
    assert.deepEqual(data, [
        { key: '2026-07-01', 'a@x.com': 1, 'b@x.com': 0 },
        { key: '2026-07-02', 'a@x.com': 3, 'b@x.com': 2 },
    ]);
});

test('days come out sorted even when rows arrive shuffled', () => {
    const { data } = buildUserSpendSeries([
        row('2026-07-03', 'a@x.com', 1),
        row('2026-07-01', 'a@x.com', 2),
        row('2026-07-02', 'a@x.com', 3),
    ]);
    assert.deepEqual(data.map((d) => d.key), ['2026-07-01', '2026-07-02', '2026-07-03']);
});

test('beyond topN, remaining users fold into Others (always last)', () => {
    const rows = [
        row('2026-07-01', 'big@x.com', 100),
        row('2026-07-01', 'mid@x.com', 10),
        row('2026-07-01', 'tiny1@x.com', 1),
        row('2026-07-01', 'tiny2@x.com', 2),
    ];
    const { data, series } = buildUserSpendSeries(rows, 2);
    assert.deepEqual(series, ['big@x.com', 'mid@x.com', OTHERS]);
    assert.equal(data[0][OTHERS], 3); // tiny1 + tiny2 aggregated
    assert.equal(data[0]['big@x.com'], 100);
});

test('no Others series when everyone fits in topN', () => {
    const { series } = buildUserSpendSeries([row('2026-07-01', 'a@x.com', 1)], 8);
    assert.deepEqual(series, ['a@x.com']);
});

test('empty/absent input → empty chart, no crash', () => {
    assert.deepEqual(buildUserSpendSeries([]), { data: [], series: [] });
    assert.deepEqual(buildUserSpendSeries(undefined), { data: [], series: [] });
});

test('valueKey pivots other metrics (task counts) and ranks by them', () => {
    const rows = [
        { key: '2026-07-01', series: 'busy@x.com', cost_usd: 0, tasks: 9 },
        { key: '2026-07-01', series: 'quiet@x.com', cost_usd: 99, tasks: 1 },
    ];
    const { data, series } = buildUserSpendSeries(rows, 1, 'tasks');
    assert.deepEqual(series, ['busy@x.com', OTHERS]); // ranked by tasks, not cost
    assert.equal(data[0]['busy@x.com'], 9);
    assert.equal(data[0][OTHERS], 1);
});

test('string costs from Postgres are coerced to numbers', () => {
    const { data } = buildUserSpendSeries([row('2026-07-01', 'a@x.com', '1.5')]);
    assert.equal(data[0]['a@x.com'], 1.5);
});
