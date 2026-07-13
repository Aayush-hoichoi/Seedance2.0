import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    APERTURES, CINEMATIC_PRESETS, DEFAULT_SETUP, FOCAL_MIN, FOCAL_MAX, APERTURE_DEFAULT,
    presetToSetup, sanitizeSetup, summarize, cinematicToPayload, findCamera, findLens,
} from '../lib/seedance/cinematic.mjs';

test('DEFAULT_SETUP is valid and self-consistent', () => {
    assert.ok(findCamera(DEFAULT_SETUP.cameraId));
    assert.ok(findLens(DEFAULT_SETUP.lensId));
    assert.ok(APERTURES.includes(DEFAULT_SETUP.aperture));
});

test('every built-in preset references real catalog ids', () => {
    for (const p of CINEMATIC_PRESETS) {
        assert.ok(findCamera(p.cameraId), `camera ${p.cameraId}`);
        assert.ok(findLens(p.lensId), `lens ${p.lensId}`);
        assert.ok(APERTURES.includes(p.aperture), `aperture ${p.aperture}`);
        assert.ok(p.focalLength >= FOCAL_MIN && p.focalLength <= FOCAL_MAX, `focal ${p.focalLength}`);
    }
});

test('summarize renders a human chip', () => {
    const s = presetToSetup(CINEMATIC_PRESETS[0]); // Classic 16mm Film / 50 / f11
    assert.equal(summarize(s), 'Classic 16mm Film · 50mm · f/11');
    assert.equal(summarize(null), null);
});

test('cinematicToPayload labels each field for GPT-4o', () => {
    const s = presetToSetup(CINEMATIC_PRESETS[0]);
    assert.deepEqual(cinematicToPayload(s), {
        camera: 'Classic 16mm Film (film)',
        lens: 'Classic Anamorphic (anamorphic)',
        focalLength: '50mm',
        aperture: 'f/11',
    });
    assert.equal(cinematicToPayload(null), null);
});

test('sanitizeSetup coerces unknown ids and out-of-range values', () => {
    const bad = sanitizeSetup({ cameraId: 'nope', lensId: 'nope', focalLength: 9999, aperture: 3.3, presetId: 'x' });
    assert.equal(bad.cameraId, DEFAULT_SETUP.cameraId);
    assert.equal(bad.lensId, DEFAULT_SETUP.lensId);
    assert.equal(bad.focalLength, FOCAL_MAX); // clamped to max
    assert.equal(bad.aperture, APERTURE_DEFAULT); // not a real f-stop → default
    assert.equal(bad.presetId, 'x');
    assert.equal(sanitizeSetup(null), null);
});

test('sanitizeSetup clamps below min and rounds focal length', () => {
    assert.equal(sanitizeSetup({ focalLength: 5 }).focalLength, FOCAL_MIN);
    assert.equal(sanitizeSetup({ focalLength: 50.7 }).focalLength, 51);
});

test('styleBriefs registers the cinematic_camera style', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../lib/openai/styleBriefs.js'), 'utf8');
    assert.match(src, /cinematic_camera:/);
    assert.match(src, /Cinematic Cameras/);
    assert.match(src, /text-to-image/i); // targets an image model, not video
});
