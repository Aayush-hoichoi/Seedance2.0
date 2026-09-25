import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptRefreshedStyle, buildRefreshMessages } from '../lib/gateway/workflowRefresh.mjs';

const CURRENT = {
    enabled: true, version: 3, defaultLook: 'pixar', sourceProjects: [28],
    looks: { pixar: { name: 'Pixar', brief: 'high-end stylized 3D animated feature-film quality' } },
    characters: { Maahi: 'powder-blue baby elephant' },
};

test('an accepted refresh bumps OUR version and keeps OUR provenance fields', () => {
    const proposed = {
        ...CURRENT,
        enabled: false,            // the model must not be able to switch a workflow off
        version: 99,               // ...or fake lineage
        sourceProjects: [1, 2, 3], // ...or widen its own corpus
        looks: { pixar: { name: 'Pixar', brief: 'high-end stylized 3D, soft dreamy sunlight, floating pollen' } },
    };
    const out = acceptRefreshedStyle(CURRENT, proposed);
    assert.equal(out.error, undefined);
    assert.equal(out.style.version, 4);
    assert.equal(out.style.enabled, true);
    assert.deepEqual(out.style.sourceProjects, [28]);
    assert.match(out.style.looks.pixar.brief, /floating pollen/);
});

test('output that fails style validation is rejected, not stored', () => {
    assert.ok(acceptRefreshedStyle(CURRENT, null).error);
    assert.ok(acceptRefreshedStyle(CURRENT, { looks: {} }).error);
    assert.ok(acceptRefreshedStyle(CURRENT, {
        ...CURRENT,
        looks: { pixar: { brief: 'x'.repeat(4001) } }, // over the brief cap
    }).error);
});

test('a no-op proposal reports unchanged instead of minting an empty version', () => {
    const out = acceptRefreshedStyle(CURRENT, JSON.parse(JSON.stringify(CURRENT)));
    assert.equal(out.unchanged, true);
    assert.equal(out.style, undefined);
});

test('refresh messages carry the current style and every liked exemplar', () => {
    const messages = buildRefreshMessages({ id: 1, name: 'Mahi Style', style: CURRENT }, ['liked one', 'liked two']);
    assert.equal(messages.length, 2);
    assert.match(messages[1].content, /Mahi Style/);
    assert.match(messages[1].content, /liked one/);
    assert.match(messages[1].content, /liked two/);
});
