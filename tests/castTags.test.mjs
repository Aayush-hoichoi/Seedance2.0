import test from 'node:test';
import assert from 'node:assert/strict';
import { castTokenRe, filterCast, bindCastTokens } from '../lib/seedance/castTags.mjs';

const CAST = [
    { name: 'Riya' },
    { name: 'Riya Sharma' },
    { name: 'Dr. Bose (old)' }, // regex metacharacters must be escaped
];

test('castTokenRe matches the longest name first and survives metacharacters', () => {
    const re = castTokenRe(CAST.map((c) => c.name));
    assert.deepEqual('Scene: @Riya Sharma greets @Riya and @Dr. Bose (old).'.match(re), ['@Riya Sharma', '@Riya', '@Dr. Bose (old)']);
    assert.equal(castTokenRe([]), null);
});

test('filterCast ignores case and spaces', () => {
    assert.deepEqual(filterCast(CAST, 'riyash'), [{ name: 'Riya Sharma' }]);
    assert.equal(filterCast(CAST, '').length, 3);
});

test('bindCastTokens emits the bare name without tags, and binds to a positional tag with them', () => {
    assert.equal(bindCastTokens('@riya walks away.', CAST), 'Riya walks away.'); // canonical casing restored
    const tags = [{ name: 'Riya', label: 'Image 2' }];
    assert.equal(bindCastTokens('@Riya walks away.', CAST, tags), 'Riya (@Image 2) walks away.');
    assert.equal(bindCastTokens('no tokens here', CAST, tags), 'no tokens here');
    assert.equal(bindCastTokens('@Riya Sharma waves.', CAST, tags), 'Riya Sharma waves.'); // longest match, no tag → bare name
});
