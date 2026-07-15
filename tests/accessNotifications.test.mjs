import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildRequestedEmail, buildDecidedEmail, modelLabel,
} from '../lib/notify/accessNotifications.mjs';
import { sendEmail, emailConfigured } from '../lib/notify/email.mjs';
import { MODELS } from '../lib/seedance/constants.js';

// A real gated video id (env-configurable, so derive it instead of hardcoding).
const VIDEO_ID = MODELS.find((m) => m.gated).id;

test('modelLabel resolves known ids, falls back to the raw id', () => {
    assert.equal(modelLabel('nano-banana-2'), 'Nano Banana 2');
    assert.equal(modelLabel(VIDEO_ID), MODELS.find((m) => m.id === VIDEO_ID).name);
    assert.equal(modelLabel('unknown-xyz'), 'unknown-xyz');
});

test('buildRequestedEmail targets ananya by default and names user/model/project', () => {
    delete process.env.MODEL_ACCESS_NOTIFY_TO;
    const m = buildRequestedEmail({ email: 'u@x.com', modelId: 'nano-banana-pro', projectName: 'Alpha', note: 'need it' });
    assert.equal(m.to, 'ananya@hoichoi.tv');
    assert.match(m.subject, /u@x\.com/);
    assert.match(m.subject, /Nano Banana Pro/);
    assert.match(m.html, /Alpha/);
    assert.match(m.html, /need it/);
    assert.match(m.text, /Alpha/);
});

test('buildRequestedEmail honors MODEL_ACCESS_NOTIFY_TO override', () => {
    process.env.MODEL_ACCESS_NOTIFY_TO = 'ops@hoichoi.tv';
    const m = buildRequestedEmail({ email: 'u@x.com', modelId: 'nano-banana-2', projectName: 'P' });
    assert.equal(m.to, 'ops@hoichoi.tv');
    delete process.env.MODEL_ACCESS_NOTIFY_TO;
});

test('buildRequestedEmail escapes HTML in the note (no injection)', () => {
    const m = buildRequestedEmail({ email: 'u@x.com', modelId: 'nano-banana-2', projectName: 'P', note: '<script>bad()</script>' });
    assert.ok(!m.html.includes('<script>'), 'raw <script> must not survive into the HTML');
    assert.match(m.html, /&lt;script&gt;/);
});

test('buildDecidedEmail — approved carries the expiry and goes to the requester', () => {
    const m = buildDecidedEmail({ email: 'u@x.com', modelId: 'nano-banana-pro', status: 'approved', expiresAt: '2026-08-01T00:00:00.000Z' });
    assert.equal(m.to, 'u@x.com');
    assert.match(m.subject, /Approved/);
    assert.match(m.html, /Approved/);
    assert.match(m.html, /2026/);
});

test('buildDecidedEmail — revoked reads as declined', () => {
    const m = buildDecidedEmail({ email: 'u@x.com', modelId: 'nano-banana-pro', status: 'revoked' });
    assert.match(m.subject, /Update on your/);
    assert.match(m.html, /declined/i);
    assert.ok(!/Approved/.test(m.html));
});

test('sendEmail no-ops (never throws) when SMTP is unconfigured', async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    assert.equal(emailConfigured(), false);
    const r = await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>h</p>' });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
});
