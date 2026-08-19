import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizePromptForApi, restorePromptTokens, tagToken } from '../lib/seedance/tags.js';

// Seedance binds a reference asset to the words ONLY through its @-token. The
// ModelArk docs are unambiguous — "Use @Image 1, @Video 1, and @Audio 1 to refer
// to reference assets" — and every official example keeps the @:
//
//   "referring to the composition of @Video1"
//   "replace the character in @Video 1 with the character in @Image 1"
//
// We were stripping it on the way out, deliberately, on the belief the API
// wanted bare "Image 1". A production job attached 3 images + 1 video and got a
// video honouring none of them: the assets arrived, the binding did not.

test('the @ survives into the API prompt — the whole point', () => {
    const out = normalizePromptForApi('Replicate @Video1, replace her with @Image1');
    assert.match(out, /@Video 1/);
    assert.match(out, /@Image 1/);
    assert.doesNotMatch(out, /(^|[^@])\bVideo 1\b/, 'a bare "Video 1" binds nothing');
});

test('casing and spacing the user typed are normalised, the @ is not', () => {
    const out = normalizePromptForApi('use @image 2 and @IMAGE3 and @video1');
    assert.equal(out, 'use @Image 2 and @Image 3 and @Video 1');
});

test('prose that merely mentions a reference is left alone', () => {
    const prose = 'The video should feel like Image 1 from the brief.';
    assert.equal(normalizePromptForApi(prose), prose,
        'only @-tokens are rewritten — untagged words must not become bindings');
});

test('Reuse repaints tokens from the new @ wording', () => {
    const stored = normalizePromptForApi('Replicate @Video1 with @Image1');
    const tags = [{ kind: 'video', number: 1 }, { kind: 'image', number: 1 }];
    assert.equal(restorePromptTokens(stored, tags), 'Replicate @Video1 with @Image1');
});

test('Reuse still repaints prompts saved before the @ was preserved', () => {
    // Every prompt stored until now carries the bare wording; Reuse must not
    // silently drop their chips.
    const legacy = 'Replicate Video 1 exactly, replace her with Image 1';
    const tags = [{ kind: 'video', number: 1 }, { kind: 'image', number: 1 }];
    assert.equal(restorePromptTokens(legacy, tags), 'Replicate @Video1 exactly, replace her with @Image1');
});

test('Reuse does not invent a reference that was never attached', () => {
    const tags = [{ kind: 'image', number: 1 }];
    assert.equal(restorePromptTokens('see Image 1 and Image 7', tags), 'see @Image1 and Image 7',
        'Image 7 has no asset behind it and must stay prose');
});

test('normalise then restore is stable across a round trip', () => {
    const tags = [{ kind: 'video', number: 1 }, { kind: 'image', number: 2 }];
    const once = restorePromptTokens(normalizePromptForApi('@Video1 plus @Image2'), tags);
    const twice = restorePromptTokens(normalizePromptForApi(once), tags);
    assert.equal(once, twice, 'repeated Reuse must not drift');
});

test('the enhancer is handed @-tokens and told to keep them verbatim', () => {
    const studio = readFileSync(new URL('../app/seedance/SeedanceStudio.jsx', import.meta.url), 'utf8');
    assert.match(studio, /assets: tags\.map\(\(t\) => \(\{ label: tagToken\(t\)/,
        'sending the bare label is what let the enhancer rewrite it away');

    const route = readFileSync(new URL('../app/api/openai/enhance/route.js', import.meta.url), 'utf8');
    assert.match(route, /exact @-token/);
    assert.match(route, /including the leading/,
        'the instruction must be explicit — "exact labels" alone did not hold');
});

test('tagToken produces the documented form', () => {
    assert.equal(tagToken({ label: 'Image 1' }), '@Image1');
    assert.equal(tagToken({ label: 'Video 2' }), '@Video2');
});
