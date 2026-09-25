// Self-updating workflows: each workflow's style was distilled from its show's
// liked history ONCE (scripts/seed-project-styles.mjs). This module keeps that
// distillation running: it gathers the generations users have LIKED since the
// last refresh — both ones stamped with the workflow and ones from the show's
// own projects — and asks the enhancer model to fold what keeps recurring in
// them back into the style, as a NEW version.
//
// Guardrails, because an unattended LLM edit to a production style bible is a
// sharp knife:
//   • the model's output must pass styleError() or the update is dropped;
//   • enabled/sourceProjects/version are OURS — the model cannot flip a
//     workflow off, widen its corpus, or fake its lineage;
//   • every accepted update is a version bump + audit_log row, so the
//     style-performance view shows v2 against v1 and audit holds the rollback;
//   • fewer than MIN_NEW_LIKES new liked samples → do nothing. Silence is not
//     a signal to rewrite anything.

import { styleError } from './projectStyle.mjs';
import { writeAudit } from './db.js';

export const MIN_NEW_LIKES = 8;    // enough recurrence to learn from, not noise
export const MAX_EXEMPLARS = 30;   // newest liked prompts sent to the model
const EXEMPLAR_CHARS = 1500;       // per-prompt cap keeps the call bounded

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// The liked corpus for one workflow since its last refresh: prompts the
// provider actually received (sent_prompt) on generations somebody liked,
// stamped with this workflow OR from the show's own projects (so the loop
// learns from the team's existing habits before workflow adoption is total).
async function likedExemplars(sql, workflow, since) {
    const projects = Array.isArray(workflow.style?.sourceProjects) ? workflow.style.sourceProjects : [];
    const rows = await sql`
        SELECT coalesce(sent_prompt, prompt) AS text, likes, created_at
        FROM dataset_samples
        WHERE likes > 0
          AND coalesce(sent_prompt, prompt) IS NOT NULL
          AND created_at > ${since}
          AND (style_workflow = ${workflow.id}
               OR project_id = ANY(${projects.length ? projects : [-1]}::int[]))
        ORDER BY created_at DESC
        LIMIT ${MAX_EXEMPLARS}`;
    return rows.map((r) => r.text.slice(0, EXEMPLAR_CHARS));
}

export function buildRefreshMessages(workflow, exemplars) {
    return [
        {
            role: 'system',
            content: [
                'You maintain the style bible of an AI video/image generation workflow. You will receive the CURRENT style JSON and prompts from recently LIKED generations (approved by the creative team).',
                'Update the style JSON so it keeps producing what the team likes:',
                '- Fold in wording/elements that RECUR across the liked prompts (lighting, palette, camera, shading, motion rules).',
                '- NEVER weaken identity locks: character descriptions, wardrobe, formats and negatives stay unless the liked prompts consistently contradict them.',
                '- Briefs must stay pure LOOK (rendering, lighting, camera, motion rules). Subjects, vehicles, locations and world descriptions belong in `characters` or `scenes` (with `match` keywords), NEVER in a brief — content in a brief overrides unrelated prompts.',
                '- Keep the exact same JSON schema and look keys. Each brief ≤ 4000 chars, negatives ≤ 2000, characters ≤ 1500 each, scene texts ≤ 2000 each.',
                '- If the liked prompts show no real pattern beyond the current style, return the current JSON unchanged.',
                'Return ONLY the JSON object — no markdown, no commentary.',
            ].join('\n'),
        },
        {
            role: 'user',
            content: `CURRENT STYLE JSON for "${workflow.name}":\n${JSON.stringify(workflow.style)}\n\nRECENTLY LIKED PROMPTS (newest first):\n${exemplars.map((t, i) => `--- liked #${i + 1} ---\n${t}`).join('\n')}`,
        },
    ];
}

// Validate + normalize what the model returned. The caller owns version and
// provenance fields; the model owns only the creative text.
export function acceptRefreshedStyle(current, proposed) {
    if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
        return { error: 'not an object' };
    }
    const next = {
        ...proposed,
        enabled: current.enabled !== false,
        sourceProjects: current.sourceProjects,
        version: (current.version ?? 0) + 1,
        refreshedAt: null, // stamped by the caller with its clock
    };
    const invalid = styleError(next);
    if (invalid) return { error: invalid };
    if (JSON.stringify({ ...next, version: 0, refreshedAt: null })
        === JSON.stringify({ ...current, version: 0, refreshedAt: null })) {
        return { unchanged: true };
    }
    return { style: next };
}

async function proposeStyle(workflow, exemplars) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
    const model = process.env.OPENAI_ENHANCE_MODEL?.trim() || 'gpt-5.6-luna';
    const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: buildRefreshMessages(workflow, exemplars),
            response_format: { type: 'json_object' },
        }),
    });
    if (!res.ok) throw new Error(`enhancer returned ${res.status}`);
    const data = await res.json();
    return JSON.parse(data?.choices?.[0]?.message?.content ?? 'null');
}

// The entry point the daily cron (and the manual script) calls. Best-effort
// per workflow: one failing refresh never blocks the others.
export async function refreshWorkflowStyles(sql, { now = new Date() } = {}) {
    const workflows = await sql`SELECT id, name, style FROM workflows WHERE deleted_at IS NULL`;
    const summary = [];
    for (const workflow of workflows) {
        try {
            const since = workflow.style?.refreshedAt || '1970-01-01';
            const exemplars = await likedExemplars(sql, workflow, since);
            if (exemplars.length < MIN_NEW_LIKES) {
                summary.push({ id: workflow.id, name: workflow.name, skipped: `only ${exemplars.length} new liked samples` });
                continue;
            }
            const proposed = await proposeStyle(workflow, exemplars);
            const accepted = acceptRefreshedStyle(workflow.style, proposed);
            if (accepted.error) {
                summary.push({ id: workflow.id, name: workflow.name, rejected: accepted.error });
                continue;
            }
            // Even "unchanged" advances the refresh cursor: the same liked
            // prompts should not be re-judged every night forever.
            const style = accepted.style ?? workflow.style;
            const stamped = { ...style, refreshedAt: now.toISOString() };
            await sql`UPDATE workflows SET style = ${JSON.stringify(stamped)}::jsonb WHERE id = ${workflow.id}`;
            if (accepted.style) {
                await writeAudit(sql, {
                    actorId: 'system:workflow-refresh', action: 'workflow.style_refreshed',
                    targetType: 'workflow', targetId: workflow.id,
                    before: workflow.style, after: stamped,
                    reason: `learned from ${exemplars.length} liked generations`,
                });
            }
            summary.push({
                id: workflow.id, name: workflow.name,
                ...(accepted.style ? { updated: `v${stamped.version}, from ${exemplars.length} liked` } : { unchanged: true }),
            });
        } catch (error) {
            summary.push({ id: workflow.id, name: workflow.name, failed: error.message });
        }
    }
    return summary;
}
