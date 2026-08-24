// A video tier is wired across THREE files that never import each other:
//   lib/seedance/constants.js   MODELS[].kind      — what the studio picker offers
//   lib/db/seeds.mjs            catalog().kind     — what the database catalogues
//   lib/seedance/pricing.mjs    RATES[kind]        — what the budget reserves against
// The studio resolves a user's allowed models by matching `kind` between the
// first two (SeedanceStudio bridges provider tag → alias via kind), so a typo in
// one file makes a model seed cleanly, return from /api/models, report as
// allowed, and STILL never appear in the picker — with no error anywhere. A
// missing pricing entry is worse than silent: estimateCost() returns null, no
// reservation is taken, and the tier generates outside quota enforcement.
// These are the joins, so they get a test rather than a comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, IMAGE_MODELS, supportedResolutionsFor } from '../lib/seedance/constants.js';
import { catalog } from '../lib/db/seeds.mjs';
import { estimateCost, unitPrice } from '../lib/seedance/pricing.mjs';
import { imageRate } from '../lib/gateway/imagePricing.mjs';

const videoCatalog = catalog().filter((m) => m.category === 'video');
const imageCatalog = catalog().filter((m) => m.category === 'image');

test('every catalogued video kind is offered by the studio picker', () => {
    const studioKinds = new Set(MODELS.map((m) => m.kind));
    for (const entry of videoCatalog) {
        assert.ok(studioKinds.has(entry.kind),
            `${entry.id} is catalogued as kind '${entry.kind}' but no MODELS entry carries it — it would never render`);
    }
});

test('every studio video kind is priced — an unpriced tier escapes budget enforcement', () => {
    for (const model of MODELS) {
        const price = unitPrice(model.kind, '720p', false);
        assert.ok(typeof price === 'number' && price > 0,
            `${model.name} (kind '${model.kind}') has no RATES entry`);
        const estimate = estimateCost({ kind: model.kind, resolution: '720p', duration: 5 });
        assert.ok(typeof estimate === 'number' && estimate > 0,
            `${model.name} (kind '${model.kind}') has no EXAMPLE_5S entry, so no reservation is taken`);
    }
});

test('a catalogued tier resolves its quality ladder from either alias or provider tag', () => {
    for (const entry of videoCatalog) {
        const byAlias = supportedResolutionsFor(entry.id);
        assert.ok(Array.isArray(byAlias) && byAlias.length,
            `${entry.id} has no resolution ladder — admins would have nothing to grant`);
    }
});

// --- the same three joins, for image models -----------------------------------
//
// Image models join on the ALIAS (not the kind, as video does): the studio, the
// catalog and the access-request flow all key on lib/seedance/constants.js
// IMAGE_MODELS[].id === seeds catalog().id. An alias present in one and absent
// from the other produces the same silent nothing described at the top of this
// file — the model seeds, /api/models returns it as allowed, and the picker
// never renders it.

test('every catalogued image model is offered by the studio picker', () => {
    const studioIds = new Set(IMAGE_MODELS.map((m) => m.id));
    for (const entry of imageCatalog) {
        assert.ok(studioIds.has(entry.id),
            `${entry.id} is catalogued but has no IMAGE_MODELS entry — it would never render`);
    }
});

test('the studio and the catalog agree on each image model kind', () => {
    for (const entry of imageCatalog) {
        const model = IMAGE_MODELS.find((m) => m.id === entry.id);
        assert.equal(model.kind, entry.kind,
            `${entry.id}: picker kind '${model.kind}' vs catalogued '${entry.kind}' — pricing keys off this`);
    }
});

test('every image kind is priced at every tier it offers — an unpriced tier escapes budget enforcement', () => {
    for (const model of IMAGE_MODELS) {
        for (const tier of model.resolutions ?? [null]) {
            const rate = imageRate(model.kind, 'interactive', tier);
            assert.ok(typeof rate === 'number' && rate > 0,
                `${model.name} (kind '${model.kind}') has no rate at ${tier ?? 'default'} — no reservation would be taken`);
        }
    }
});

test('a catalogued image model resolves the quality ladder admins grant against', () => {
    for (const entry of imageCatalog) {
        const ladder = supportedResolutionsFor(entry.id);
        assert.ok(Array.isArray(ladder) && ladder.length,
            `${entry.id} has no resolution ladder — admins would have nothing to grant`);
    }
});

// --- ChatGPT Image 2 specifically ---------------------------------------------

test('ChatGPT Image 2 ships gated: catalogued and active, but never an org default', () => {
    const entry = catalog().find((m) => m.id === 'chatgpt-image-2');
    assert.ok(entry, 'chatgpt-image-2 must be in the catalog');
    assert.equal(entry.isDefault, false, 'an org default would bypass the approval flow entirely');
    assert.equal(entry.provider, 'kie');
    assert.equal(entry.category, 'image');
    // The catalog holds kie's TEXT-TO-IMAGE slug; the adapter derives the
    // image-to-image sibling from it, so the suffix is load-bearing.
    assert.equal(entry.providerModelId.endsWith('-text-to-image'), true);
    assert.equal(entry.route.timeoutSeconds, 900, 'kie tasks outlive the 300s image-class default');
});

// --- Seedance 2.5 specifically ------------------------------------------------
//
// It ships on the gated path, exactly like Seedance 2.0: catalogued and active,
// but reachable only after an admin approves. The two flags that carry that are
// isDefault (an org default is an implicit grant to everyone) and gated (below).

test('Seedance 2.5 is catalogued and is never an org default', () => {
    const entry = catalog().find((m) => m.id === 'seedance-2.5');
    assert.ok(entry, 'seedance-2.5 must be in the catalog');
    assert.equal(entry.isDefault, false, 'an org default would bypass the approval flow');
    assert.equal(entry.kind, 'full_2_5');
    assert.equal(entry.providerModelId.startsWith('dreamina-seedance-2-5-'), true);
});

test('Seedance 2.5 carries the same access posture as Seedance 2.0', () => {
    const [two, twoFive] = ['seedance-2.0', 'seedance-2.5'].map((id) => catalog().find((m) => m.id === id));
    assert.equal(twoFive.isDefault, two.isDefault, 'default-ness must match 2.0');
    assert.equal(twoFive.active ?? true, two.active ?? true, 'activeness must match 2.0');
    const studio = (kind) => MODELS.find((m) => m.kind === kind);
    assert.equal(studio(twoFive.kind).gated, studio(two.kind).gated, 'gating must match 2.0');
});

test('Seedance 2.5 is gated, so activation alone never grants anyone access', () => {
    const model = MODELS.find((m) => m.kind === 'full_2_5');
    assert.ok(model, 'the studio must know the 2.5 tier');
    assert.equal(model.gated, true, 'ungated would make it open the moment it is activated');
});

// A capability claim here is what the picker offers, what an admin may grant,
// and what gets priced — but the provider is the only thing that actually knows.
// 2.5 shipped as 1080p/4k-capable by analogy with 2.0 and users hit
// "resolution 1080p is not supported for this account and model" at submit time,
// after the request had been priced. Verified per-tier against the live API:
//   2026-08-13  480p/720p accepted, 1080p and 4k rejected  -> capped at 720p
//   2026-08-18  480p/720p/1080p accepted, 4k rejected      -> 1080p re-enabled
// The 1080p refusal was account-scoped and lifted on its own, so this ladder
// tracks a live probe, never an assumption. 4k is a model limit.
test('Seedance 2.5 offers only the tiers the provider actually accepts', () => {
    const model = MODELS.find((m) => m.kind === 'full_2_5');
    assert.equal(model.supports1080p, true, '1080p accepted for this account since 2026-08-18');
    assert.equal(model.supports4k, false, '4k is not valid for this model in t2v');
    assert.deepEqual(supportedResolutionsFor('seedance-2.5'), ['480p', '720p', '1080p'],
        'the grantable ladder must not promise a tier the provider rejects');
    assert.deepEqual(supportedResolutionsFor(model.id), ['480p', '720p', '1080p'],
        'same ladder via the provider tag');
});

test('the catalog caps agree with the studio capability flags', () => {
    const entry = catalog().find((m) => m.id === 'seedance-2.5');
    const model = MODELS.find((m) => m.kind === 'full_2_5');
    assert.equal(entry.caps.supports1080p, model.supports1080p);
    assert.equal(entry.caps.supports4k, model.supports4k);
});
