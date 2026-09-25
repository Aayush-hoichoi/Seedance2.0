import test from 'node:test';
import assert from 'node:assert/strict';
import {
    composeStyledPrompt, applyStyledImagePrompt, applyStyledVideoPrompt, videoPromptOf,
    styleError, styleSummary,
} from '../lib/gateway/projectStyle.mjs';
import { GATEWAY_DDL, SCHEMA_VERSION } from '../lib/db/schema.mjs';

const STYLE = {
    enabled: true,
    version: 3,
    defaultLook: 'global',
    looks: {
        global: {
            name: 'Painterly 3D game-sim',
            brief: 'Stylized painterly 3D game-simulation render, AAA stylized game cinematic quality, painterly matte-finish skin shader, soft highlight rolloff, subtle painterly grain.',
            negatives: 'photoreal drift, oily or glossy skin, anime or 2D cel shading, ink outline.',
        },
        window: { name: 'Window look', brief: 'Strong barrel lens distortion, heavy rounded vignette, letterbox bars top and bottom.' },
    },
    characters: {
        Menaka: 'gold filigree tiara, red bindi, sheer copper-rose veil with gold edge, cream pleated saree.',
        Parvati: 'thick left-shoulder braid with lilac flower ornaments, deep maroon saree with gold border.',
    },
};

test('a project with no style is left completely alone', () => {
    for (const style of [null, undefined, {}, { enabled: false, looks: STYLE.looks }]) {
        const out = composeStyledPrompt('Himalaya walks through the blizzard.', style);
        assert.equal(out.applied, false);
        assert.equal(out.prompt, 'Himalaya walks through the blizzard.');
    }
});

test('the default look is appended, with the precedence header', () => {
    const out = composeStyledPrompt('Himalaya walks through the blizzard.', STYLE);
    assert.equal(out.applied, true);
    assert.equal(out.look, 'global');
    assert.equal(out.version, 3);
    assert.match(out.prompt, /^Himalaya walks through the blizzard\./);
    assert.match(out.prompt, /painterly matte-finish skin shader/);
    assert.match(out.prompt, /NEVER: photoreal drift/);
    // The whole point of the header: the shot's action and the style block are
    // allowed to disagree, and the model must know which wins for what. Without
    // this the block reads as a contradiction and the model splits the
    // difference on both.
    assert.match(out.prompt, /conflict on LOOK, these rules win/);
    assert.match(out.prompt, /conflict on ACTION, the text above wins/);
});

// The Good Samaritan regression: content baked into a brief rode along on
// every prompt, so "an elephant is running in jungle" rendered the car chase.
const GATED = {
    enabled: true,
    version: 3,
    defaultLook: 'base',
    looks: {
        yacht: { name: 'Yacht', match: ['yacht', 'deck'], brief: 'Golden-hour sunset light, shallow depth of field.' },
        base: { name: 'Photoreal', brief: 'Photorealistic cinematic look, natural bright daylight, 24fps.' },
    },
    scenes: {
        vellfire: { match: ['car', 'chase', 'vellfire'], text: 'HERO VEHICLES: a modified black Toyota Vellfire, plate VPR 6315.' },
        street: { match: ['street', 'market', 'chase'], text: 'WORLD: a busy Indonesian market street with becaks.' },
    },
};

test('scene locks inject only when the prompt references them — an elephant never gets the car chase', () => {
    const elephant = composeStyledPrompt('a elephant is running in jungle', GATED);
    assert.equal(elephant.applied, true);
    assert.match(elephant.prompt, /Photorealistic cinematic look/); // the LOOK still applies
    assert.doesNotMatch(elephant.prompt, /Vellfire/);
    assert.doesNotMatch(elephant.prompt, /market street/);

    const chase = composeStyledPrompt('the black car weaves through a market street chase', GATED);
    assert.match(chase.prompt, /Vellfire, plate VPR 6315/);
    assert.match(chase.prompt, /Indonesian market street/);
});

test('a look with match keywords is auto-picked from the prompt; explicit look still wins', () => {
    const auto = composeStyledPrompt('two friends talk on the yacht deck', GATED);
    assert.equal(auto.look, 'yacht');
    assert.match(auto.prompt, /Golden-hour sunset/);

    const unmatched = composeStyledPrompt('a elephant is running in jungle', GATED);
    assert.equal(unmatched.look, 'base'); // nothing matched → default

    const explicit = composeStyledPrompt('two friends talk on the yacht deck', GATED, { look: 'base' });
    assert.equal(explicit.look, 'base'); // the user's choice beats keywords
});

test('styleError validates scenes and match keywords', () => {
    assert.equal(styleError(GATED), null);
    assert.ok(styleError({ ...GATED, scenes: { bad: { text: 'no match words' } } }));
    assert.ok(styleError({ ...GATED, scenes: { bad: { match: ['x'], text: '' } } }));
    assert.ok(styleError({ ...GATED, scenes: { bad: { match: ['x'], text: 'y'.repeat(2001) } } }));
    assert.ok(styleError({ ...GATED, looks: { a: { brief: 'ok', match: [] } } }));
});

test('an explicit look overrides the default, and "none" opts one generation out', () => {
    const picked = composeStyledPrompt('A car turns.', STYLE, { look: 'window' });
    assert.equal(picked.look, 'window');
    assert.match(picked.prompt, /barrel lens distortion/);
    assert.doesNotMatch(picked.prompt, /game-simulation render/);

    const off = composeStyledPrompt('A car turns.', STYLE, { look: 'none' });
    assert.equal(off.applied, false);
    assert.equal(off.prompt, 'A car turns.');
});

test('only the characters this shot names are injected', () => {
    const out = composeStyledPrompt('Menaka bows her head in prayer.', STYLE);
    assert.match(out.prompt, /copper-rose veil/);
    // Maahi's cast sheet is seven characters long; injecting the absent ones
    // would spend the prompt budget describing people who are not in frame.
    assert.doesNotMatch(out.prompt, /lilac flower ornaments/);
});

test('boilerplate the operator already pasted is not stamped a second time', () => {
    // Operators will keep pasting the old block for weeks after this ships, and
    // a doubled style block is worse than none — the model weights the repeat.
    const pasted = `Himalaya walks. ${STYLE.looks.global.brief}`;
    const out = composeStyledPrompt(pasted, STYLE);
    const hits = out.prompt.match(/painterly matte-finish skin shader/g) || [];
    assert.equal(hits.length, 1);
    assert.match(out.prompt, /NEVER: photoreal drift/); // negatives still apply
});

test('sections are dropped rather than overrunning the provider prompt cap', () => {
    const base = 'Menaka bows. ';
    const out = composeStyledPrompt(base.padEnd(400, 'x'), STYLE, { maxPrompt: 600 });
    assert.ok(out.prompt.length <= 600, `composed prompt must respect the cap, got ${out.prompt.length}`);
    // Brief outranks the character sheet, which outranks the negatives.
    if (out.applied) assert.match(out.prompt, /game-simulation render/);
});

test('a prompt with no room at all for the brief is returned unstyled', () => {
    const out = composeStyledPrompt('x'.repeat(200), STYLE, { maxPrompt: 210 });
    assert.equal(out.applied, false);
    assert.equal(out.prompt.length, 200);
});

test('image requests carry the styled prompt in BOTH prompt and parts', () => {
    // The Google adapter reads request.parts and prefers it over request.prompt;
    // byteplus/kie/openai read request.prompt. Rewriting one silently no-ops for
    // half the model catalog.
    const request = { prompt: 'old', parts: [{ text: 'old' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] };
    const next = applyStyledImagePrompt(request, 'new styled');
    assert.equal(next.prompt, 'new styled');
    assert.equal(next.parts[0].text, 'new styled');
    assert.deepEqual(next.parts[1], request.parts[1], 'reference images must survive untouched');
    assert.equal(request.prompt, 'old', 'the caller\'s object must not be mutated');
});

test('image requests with refs but no text part gain one', () => {
    const request = { prompt: 'old', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] };
    const next = applyStyledImagePrompt(request, 'styled');
    assert.equal(next.parts[0].text, 'styled');
    assert.equal(next.parts.length, 2);
});

test('video content keeps its references and rewrites only the text entry', () => {
    const content = [
        { type: 'text', text: 'old' },
        { type: 'image_url', role: 'first_frame', image_url: { url: 'https://x/y.png' } },
    ];
    assert.equal(videoPromptOf(content), 'old');
    const next = applyStyledVideoPrompt(content, 'styled');
    assert.equal(next[0].text, 'styled');
    assert.deepEqual(next[1], content[1]);
    assert.equal(videoPromptOf(next), 'styled');
    assert.equal(videoPromptOf([{ type: 'image_url' }]), '');
});

test('schema v18 adds the project style column and the evaluation columns', () => {
    assert.ok(SCHEMA_VERSION >= 18, 'project style memory ships from v18 onward');
    assert.ok(
        GATEWAY_DDL.some((s) => /ALTER TABLE projects ADD COLUMN IF NOT EXISTS style jsonb/.test(s)),
        'projects.style must be part of the automatic schema chain',
    );

    const gallery = GATEWAY_DDL.find((s) => s.includes('CREATE OR REPLACE VIEW gallery_generations'));
    const dataset = GATEWAY_DDL.find((s) => s.includes('CREATE OR REPLACE VIEW dataset_samples'));
    assert.ok(gallery && dataset);
    // CREATE OR REPLACE VIEW only tolerates columns APPENDED to the end, and
    // gallery_generations must be replaced before dataset_samples reads its new
    // columns.
    assert.ok(GATEWAY_DDL.indexOf(gallery) < GATEWAY_DDL.indexOf(dataset));
    assert.ok(gallery.indexOf('AS video_key') < gallery.indexOf('AS style_look'));
    assert.ok(dataset.indexOf('AS likes') < dataset.indexOf('AS sent_prompt'));
    for (const col of ['project_id', 'style_look', 'style_version']) {
        assert.match(dataset, new RegExp(`g\\.${col}`), `dataset_samples must expose ${col}`);
    }
});

test('a style is validated before it can be stored', () => {
    // This text is appended to every generation the project makes, so a
    // malformed object saved here is a silent per-generation failure, not a
    // save error. Reject it at the boundary instead.
    assert.equal(styleError(null), null, 'clearing the style is always allowed');
    assert.equal(styleError(STYLE), null);
    assert.match(styleError('nope'), /must be an object/);
    assert.match(styleError({}), /looks object/);
    assert.match(styleError({ looks: {} }), /at least one look/i);
    assert.match(styleError({ looks: { a: {} } }), /needs a brief/);
    assert.match(styleError({ looks: { a: { brief: '   ' } } }), /needs a brief/);
    assert.match(styleError({ looks: { a: { brief: 'x'.repeat(5000) } } }), /too long/);
    assert.match(styleError({ looks: { a: { brief: 'x' } }, defaultLook: 'ghost' }), /not one of this project/);
    // 'none' is the reserved per-generation opt-out, so a look by that name
    // could never be selected.
    assert.match(styleError({ looks: { none: { brief: 'x' } } }), /reserved/);
    assert.match(styleError({ looks: { a: { brief: 'x' } }, characters: { X: 42 } }), /text description/);
});

test('the client summary carries the look list but never the brief prose', () => {
    const summary = styleSummary(STYLE);
    assert.deepEqual(summary.looks.map((l) => l.key), ['global', 'window']);
    assert.equal(summary.defaultLook, 'global');
    assert.equal(summary.version, 3);
    // The briefs run to several KB per project and the project list returns
    // every project the caller can see.
    assert.doesNotMatch(JSON.stringify(summary), /matte-finish/);

    assert.equal(styleSummary(null), null);
    assert.equal(styleSummary({ enabled: false, looks: STYLE.looks }), null, 'a disabled style reads as no style');
    assert.equal(styleSummary({ looks: { a: { brief: '  ' } } }), null, 'a style with no usable look reads as no style');
    // Falls back to a real look rather than pointing at a missing default.
    assert.equal(styleSummary({ looks: { a: { brief: 'x' } }, defaultLook: 'ghost' }).defaultLook, 'a');
});
