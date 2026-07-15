// The three model-access emails, as pure builders (testable, no I/O) plus thin
// senders over sendEmail(). All are best-effort — a mail failure never blocks
// the request or approval that triggered it.
//
//   notifyAccessRequested  → admin (ananya) when a user requests a gated model
//   notifyAccessDecided    → the requester when an admin approves or declines
//
// Recipient of the admin notice defaults to ananya@hoichoi.tv; override with
// MODEL_ACCESS_NOTIFY_TO. Links use APP_URL / NEXT_PUBLIC_APP_URL / Vercel's
// production URL when available, otherwise they're omitted.

import { MODELS, IMAGE_MODELS } from '../seedance/constants.js';
import { sendEmail } from './email.mjs';

const ADMIN_TO = () => process.env.MODEL_ACCESS_NOTIFY_TO || 'ananya@hoichoi.tv';

// Every value below can originate from user input (note, email, project name),
// so escape before interpolating into HTML.
function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function modelLabel(modelId) {
    const m = [...MODELS, ...IMAGE_MODELS].find((x) => x.id === modelId);
    return m ? m.name : (modelId || 'the model');
}

function appBase() {
    const raw = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
        || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
    return raw ? raw.replace(/\/+$/, '') : '';
}

function shell(heading, rowsHtml, ctaHtml = '') {
    return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
  <h2 style="font-size:17px;font-weight:600;margin:0 0 14px">${heading}</h2>
  <table style="border-collapse:collapse;font-size:14px;line-height:1.5">${rowsHtml}</table>
  ${ctaHtml}
  <p style="font-size:12px;color:#888;margin:22px 0 0">loglineAI Studio · automated notification</p>
</div>`;
}

function row(label, value) {
    return `<tr><td style="padding:3px 14px 3px 0;color:#777;vertical-align:top">${label}</td><td style="padding:3px 0;font-weight:500">${value}</td></tr>`;
}

function button(href, text) {
    return `<p style="margin:20px 0 0"><a href="${esc(href)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px;font-weight:500">${esc(text)}</a></p>`;
}

// --- Admin: a user requested access ---

export function buildRequestedEmail({ email, modelId, projectName, note }) {
    const model = modelLabel(modelId);
    const project = projectName || 'a project';
    const base = appBase();
    const rows = row('User', esc(email))
        + row('Model', esc(model))
        + row('Project', esc(project))
        + (note ? row('Note', esc(note)) : '');
    const cta = base ? button(`${base}/console/users`, 'Review in console') : '';
    return {
        to: ADMIN_TO(),
        subject: `Access request: ${email} → ${model}`,
        html: shell('New model-access request', rows, cta),
        text: `${email} requested access to ${model} on ${project}.`
            + (note ? `\nNote: ${note}` : '')
            + (base ? `\n\nReview: ${base}/console/users` : ''),
    };
}

export function notifyAccessRequested(args) {
    return sendEmail(buildRequestedEmail(args));
}

// --- Requester: the decision ---

export function buildDecidedEmail({ email, modelId, status, expiresAt }) {
    const model = modelLabel(modelId);
    const approved = status === 'approved';
    const base = appBase();
    if (approved) {
        const expiry = expiresAt ? new Date(expiresAt).toUTCString() : null;
        const rows = row('Model', esc(model))
            + row('Status', '<span style="color:#0a7a3f">Approved</span>')
            + (expiry ? row('Access until', esc(expiry)) : row('Access until', 'no expiry'));
        const cta = base ? button(`${base}/seedance`, 'Open the studio') : '';
        return {
            to: email,
            subject: `Approved: access to ${model}`,
            html: shell('Your model-access request was approved', rows, cta),
            text: `Your request for ${model} was approved`
                + (expiry ? `, valid until ${expiry}.` : '.')
                + (base ? `\n\nOpen the studio: ${base}/seedance` : ''),
        };
    }
    const rows = row('Model', esc(model))
        + row('Status', '<span style="color:#b23">Not granted</span>');
    return {
        to: email,
        subject: `Update on your ${model} access request`,
        html: shell('Your model-access request was declined', rows,
            `<p style="font-size:13px;color:#555;margin:16px 0 0">Access to ${esc(model)} isn't active. Reach out to an admin if you think this is a mistake.</p>`),
        text: `Your request for ${model} was not granted. Reach out to an admin if you think this is a mistake.`,
    };
}

export function notifyAccessDecided(args) {
    if (!args?.email) return Promise.resolve({ ok: false, skipped: true, reason: 'no recipient' });
    return sendEmail(buildDecidedEmail(args));
}
