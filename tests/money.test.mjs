import test from 'node:test';
import assert from 'node:assert/strict';
import { usd } from '../lib/seedance/money.mjs';

// The project chip and the budget badge sit inches apart in the same header and
// both render money, so they share this formatter — "$21.4" beside "$21.40"
// reads as a bug in the numbers rather than in the formatting.

test('always two decimals, never the JS default', () => {
    assert.equal(usd(21.4), '$21.40');
    assert.equal(usd(21), '$21.00');
    assert.equal(usd(0), '$0.00');
});

test('sub-cent amounts round rather than leaking precision into a glanceable badge', () => {
    assert.equal(usd(0.0301), '$0.03');
    assert.equal(usd(2.992), '$2.99');
    assert.equal(usd(0.004), '$0.00', 'a fraction of a cent is not worth a badge saying $0.0040');
});

test('thousands are grouped so a big spend stays readable', () => {
    assert.equal(usd(1234.5), '$1,234.50');
    assert.equal(usd(1234567.891), '$1,234,567.89');
});

test('a missing or unusable amount shows $0.00, never NaN or blank', () => {
    // spent_usd is absent on a project with no billing rows yet, and comes back
    // as a numeric string from some paths — neither may render "$NaN" in the header.
    for (const bad of [null, undefined, '', 'abc', NaN, Infinity, -Infinity, {}]) {
        assert.equal(usd(bad), '$0.00', `usd(${JSON.stringify(bad)}) must be safe`);
    }
});

test('numeric strings from the API are accepted', () => {
    assert.equal(usd('21.4'), '$21.40');
    assert.equal(usd('0'), '$0.00');
});

test('a negative amount keeps its sign rather than being silently zeroed', () => {
    assert.equal(usd(-5), '-$5.00');
});
