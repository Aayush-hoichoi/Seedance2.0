import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptRefreshedStyle, buildRefreshMessages, buildDescribeMessages, fallbackStyle } from '../lib/gateway/workflowRefresh.mjs';
import { styleError } from '../lib/gateway/projectStyle.mjs';

const CURRENT = {
    enabled: true, version: 3, defaultLook: 'pixar', sourceProjects: [28],
    sourceDescription: 'cute elephant family in premium 3D animation',
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
    assert.equal(out.style.sourceDescription, CURRENT.sourceDescription); // Edit's prefill survives refreshes
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

test('the creation fallback always yields a valid style — user text becomes the brief verbatim', () => {
    const style = fallbackStyle('Noir Kolkata', 'Moody black-and-white 1960s streets, heavy rain, film grain.');
    assert.equal(styleError(style), null);
    assert.equal(style.version, 1);
    assert.match(style.looks[style.defaultLook].brief, /heavy rain/);
    // Oversized inputs are clamped to the schema caps, never rejected.
    const big = fallbackStyle('N'.repeat(500), 'x'.repeat(10_000));
    assert.equal(styleError(big), null);
});

test('describe-enhancer messages: look only, faithful to the idea, media-aware', () => {
    const [system, user] = buildDescribeMessages({ name: 'Baij', description: 'ramkinkar baij sculpture style', media: 'video' });
    assert.match(system.content, /video generation/);
    assert.match(system.content, /never name specific subjects/i);
    assert.match(system.content, /Stay faithful/);
    assert.match(user.content, /ramkinkar baij sculpture style/);
    const [imgSystem] = buildDescribeMessages({ name: 'x', description: 'y', media: 'image' });
    assert.match(imgSystem.content, /still images generation/);
});

test('refresh messages carry the current style and every liked exemplar', () => {
    const messages = buildRefreshMessages({ id: 1, name: 'Mahi Style', style: CURRENT }, ['liked one', 'liked two']);
    assert.equal(messages.length, 2);
    assert.match(messages[1].content, /Mahi Style/);
    assert.match(messages[1].content, /liked one/);
    assert.match(messages[1].content, /liked two/);
});
