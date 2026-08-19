import { getApprovedModelIds, logUsage } from '../access/db.js';
import { MODELS, GATED_MODEL_IDS, RESOLUTIONS, resolutionWithinTier, supportedResolutionsFor } from '../seedance/constants.js';
import { canUseModel } from '../access/decision.mjs';
import { estimateCost } from '../seedance/pricing.mjs';
import { getDb } from '../db/neon.js';
import { effectiveAccess } from './access.mjs';
import { evaluateQuotas } from './quota.mjs';
import { activeQuotas, usageForQuotas, insertBillingEvent, reserveBillingEvent, emitEvent } from './db.js';
import { PROJECT_CONCURRENCY } from './queueLogic.mjs';

// The governed ModelArk create-task pipeline, shared by the /api/byteplus
// proxy route and the MCP create_video tool. Moved out of the route
// unmodified except: header reads become params, and NextResponse.json(...)
// returns become plain { status, body } objects (this module must stay
// framework-free — no next/server import — so it can be called directly
// from the MCP server as well as the HTTP route).

const ARK_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const CREATE_TASK_PATH = 'contents/generations/tasks';

// Seedance's own wording for "this is an edit, so the length follows the
// source". Matched on the instruction itself rather than the prose around it,
// which names the task type and the 4-30s source requirement and is far more
// likely to be reworded.
const DURATION_MUST_BE_AUTO = /`?duration`?\s+must be\s+-1/i;
const AUTO_DURATION = -1; // the API's "inherit from the input video"

export function hasVideoInput(content) {
    return Array.isArray(content) && content.some((c) => c?.type === 'video_url' || c?.role === 'reference_video');
}

// Resolve the gateway context for a studio create-task call. Returns:
//   null                  → gateway not migrated yet (legacy check applies)
//   { error: { status, body } } → governed and rejected
//   { sql, project, alias, versionId, kind, estimate } → governed, allowed
async function resolveGateway(user, modelId, projectId) {
    const sql = await getDb();
    if (!sql) return null;
    const [version] = await sql`SELECT v.*, m.category FROM model_versions v
        JOIN models m ON m.id = v.model_id WHERE v.version_tag = ${modelId} LIMIT 1`;
    if (!version) return null;

    // Project attribution — the source of truth for billing + history, so it
    // must never silently land on the wrong project:
    //   • explicit header → THAT project. Platform admins may use any project
    //     (the studio shows them all); others must be a member. An invalid/
    //     forbidden explicit project is a hard error, never a silent fallback
    //     to Default (that caused client/server divergence).
    //   • no header → the user's Default project (member-scoped).
    const headerId = Number(projectId) || null;
    const isAdmin = user.role === 'admin';
    let project;
    if (headerId) {
        [project] = isAdmin
            ? await sql`SELECT p.* FROM projects p WHERE p.id = ${headerId} AND p.archived_at IS NULL`
            : await sql`SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ${user.userId}
                WHERE p.id = ${headerId} AND p.archived_at IS NULL`;
        if (!project) {
            return { error: { status: 403, body: { code: 'NOT_A_PROJECT_MEMBER', error: 'You are not a member of the selected project — pick another or ask an admin to add you.' } } };
        }
    } else {
        [project] = await sql`SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id = p.id AND m.user_id = ${user.userId}
            WHERE p.archived_at IS NULL ORDER BY (p.name = 'Default') DESC, p.id ASC LIMIT 1`;
        if (!project) {
            return { error: { status: 403, body: { code: 'NOT_A_PROJECT_MEMBER', error: 'You are not in any project yet — ask an admin to add you.' } } };
        }
    }
    if (project.paused) {
        return { error: { status: 409, body: { code: 'PROJECT_PAUSED', error: 'This project is paused by an admin.' } } };
    }

    const grants = await sql`SELECT * FROM project_model_grants WHERE project_id = ${project.id}`;
    const overrides = await sql`SELECT * FROM user_model_overrides WHERE project_id = ${project.id} AND user_id = ${user.userId}`;
    const defaults = (await sql`SELECT id FROM models WHERE is_default = true AND active = true`).map((m) => m.id);
    const decision = effectiveAccess({ modelId: version.model_id, now: new Date(), grants, overrides, defaultModelIds: defaults });
    if (!decision.allowed) {
        return { error: { status: 403, body: { code: 'MODEL_ACCESS_DENIED', rule: decision.rule, error: 'You do not have access to this model. Request access from the model picker.' } } };
    }
    return { sql, project, alias: version.model_id, versionId: version.id, kind: version.kind, maxResolution: decision.maxResolution ?? null };
}

// Free a proxy job's slot + reservation when the provider never accepted it.
async function releaseProxyJob(gw, jobId, user, reason) {
    try {
        await gw.sql`UPDATE jobs SET status = 'failed', finished_at = now(), error = ${JSON.stringify({ message: reason })} WHERE id = ${jobId}`;
        await insertBillingEvent(gw.sql, {
            eventType: 'release', generationId: jobId, projectId: gw.project.id,
            userId: user.userId, modelId: gw.alias, modelVersionId: gw.versionId, providerId: 'byteplus',
            units: null, estCostUsd: null, costUsd: null, pricingSnapshot: null,
        });
    } catch { /* sweep's timeout path is the backstop */ }
}

export async function createVideoTask({ user, projectId = null, mode = null, request }) {
    const key = process.env.ARK_API_KEY;
    if (!key) return { status: 500, body: { error: 'ARK_API_KEY is not configured on the server.' } };
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const targetUrl = `${ARK_BASE}/${CREATE_TASK_PATH}`;
    // Resolution reaches the pricing tiers AND the provider verbatim; MCP
    // callers send free-form casing ('4K' would settle at the 'sd' token
    // rate). One lowercase at the boundary fixes both. New object, no mutation.
    const parsed = typeof request?.resolution === 'string'
        ? { ...request, resolution: request.resolution.toLowerCase() }
        : request;
    const body = JSON.stringify(parsed);
    const modelId = parsed?.model;

    // Governance. Once the gateway migration has run (org/project/catalog rows
    // exist) the FULL pipeline applies: project scoping, precedence-based
    // access, layered quotas with reservations, billing events, SSE. Before
    // that, fall back to the legacy per-user approved-model check.
    let gw = null;
    try {
        gw = await resolveGateway(user, modelId, projectId);
    } catch { gw = null; } // DB hiccup: fail open to the legacy check below
    if (gw?.error) return gw.error;

    // A granted model may still be quality-capped (admin approved a lower tier
    // than the model supports; the deploy backfill caps every legacy grant at
    // 1080p — 4k is request-only). Same code as a full denial so clients reuse
    // their handling; rule tells the picker WHY.
    if (gw && !resolutionWithinTier(parsed?.resolution, gw.maxResolution, RESOLUTIONS)) {
        return { status: 403, body: { code: 'MODEL_ACCESS_DENIED', rule: 'resolution_cap', error: `Your access covers up to ${gw.maxResolution} on this model — request ${parsed.resolution} access from the resolution picker.` } };
    }

    if (!gw) {
        const approvedModelIds = GATED_MODEL_IDS.includes(modelId) ? await getApprovedModelIds(user.userId) : [];
        if (!canUseModel({ modelId, gatedModelIds: GATED_MODEL_IDS, approvedModelIds })) {
            return { status: 403, body: { error: 'You do not have access to this model. Request access from the model picker.' } };
        }
    }

    // A grant bounds how much of a model a user may use; it cannot conjure a tier
    // the model does not have. Both ends of that could drift, and neither was
    // checked here:
    //   • a cap can outlive the capability — an admin granted 1080p on Seedance
    //     2.5 before we learned it tops out at 720p, and on 2026-08-13 five of
    //     those requests reached BytePlus and came back "resolution 1080p is not
    //     supported for this account and model", after being priced and reserved;
    //   • an UNCAPPED grant (max_resolution NULL) satisfies resolutionWithinTier
    //     for every tier, so it was bounded by nothing at all.
    // The model ladder is the hard ceiling. Checked after access so a user who
    // lacks the model still hears that first, and applied on the legacy path too.
    const modelLadder = supportedResolutionsFor(gw?.alias ?? modelId) ?? [];
    if (modelLadder.length && parsed?.resolution
        && !modelLadder.some((tier) => tier.toLowerCase() === String(parsed.resolution).toLowerCase())) {
        return {
            status: 400,
            body: {
                code: 'RESOLUTION_UNSUPPORTED', rule: 'model_capability',
                error: `This model supports up to ${modelLadder[modelLadder.length - 1]} — ${parsed.resolution} is not available for it.`,
            },
        };
    }

    // Quota check + reservation happen BEFORE the provider sees the request.
    const kind = gw?.kind ?? MODELS.find((m) => m.id === modelId)?.kind ?? null;
    const withVideo = hasVideoInput(parsed?.content);
    const estUsd = kind ? estimateCost({ kind, resolution: parsed?.resolution, duration: parsed?.duration, hasVideoInput: withVideo }) : null;
    if (gw) {
        const quotas = await activeQuotas(gw.sql);
        const usage = await usageForQuotas(gw.sql, quotas);
        const verdict = evaluateQuotas({
            quotas, projectId: gw.project.id, userId: user.userId, modelId: gw.alias, now: new Date(),
            estimate: { usd: estUsd ?? 0, video_seconds: parsed?.duration > 0 ? parsed.duration : 5, requests: 1 }, ...usage,
        });
        if (!verdict.ok) {
            const v = verdict.violations[0];
            return {
                status: 429,
                body: {
                    code: 'QUOTA_EXCEEDED',
                    error: `Budget limit reached (${v.quota.type} · ${v.quota.window})${v.resetsAt ? ` — resets ${new Date(v.resetsAt).toLocaleString()}` : ''}.`,
                    resets_at: v.resetsAt,
                },
            };
        }
    }

    // Gateway path: atomically take a concurrency slot BEFORE the provider
    // sees the request — a cap-guarded INSERT under the same advisory lock
    // claimJob uses, so concurrent submits can't oversubscribe (PRD §9.2).
    let job = null;
    if (gw) {
        const requestBody = JSON.stringify({
            options: {
                resolution: parsed?.resolution ?? null, duration: parsed?.duration ?? null,
                ratio: parsed?.ratio ?? null, mode: mode || null,
                has_video_input: withVideo, kind,
            },
            est_cost_usd: estUsd,
            category: 'video',
        });
        const [, rows] = await gw.sql.transaction([
            gw.sql`SELECT pg_advisory_xact_lock(hashtext('gateway:claim'))`,
            gw.sql`INSERT INTO jobs
                (project_id, user_id, model_id, model_version_id, priority, status, attempt,
                 request_body, provider_id, started_at, timeout_at)
                SELECT ${gw.project.id}, ${user.userId}, ${gw.alias}, ${gw.versionId}, 'interactive', 'running', 1,
                       ${requestBody}, 'byteplus', now(), now() + interval '30 minutes'
                WHERE (SELECT count(*) FROM jobs r WHERE r.project_id = ${gw.project.id} AND r.status = 'running') < ${PROJECT_CONCURRENCY}
                RETURNING id`,
        ]);
        job = rows?.[0] || null;
        if (!job) {
            return {
                status: 429,
                body: {
                    code: 'QUEUE_FULL',
                    error: `Your project already has ${PROJECT_CONCURRENCY} generations rendering — wait for one to finish.`,
                },
            };
        }
        let reservation;
        try {
            reservation = await reserveBillingEvent(gw.sql, {
                eventType: 'reservation', generationId: job.id, projectId: gw.project.id,
                userId: user.userId, modelId: gw.alias, modelVersionId: gw.versionId, providerId: 'byteplus',
                units: { video_seconds: parsed?.duration > 0 ? parsed.duration : 5 }, estCostUsd: estUsd, pricingSnapshot: { basis: 'estimate' },
            });
        } catch (error) {
            try {
                await gw.sql`UPDATE jobs SET status = 'failed', finished_at = now(),
                    error = ${JSON.stringify({ message: error.message || 'Could not reserve budget.' })}
                    WHERE id = ${job.id} AND status = 'running'`;
            } catch { /* best-effort cleanup */ }
            throw error;
        }
        if (!reservation) {
            await gw.sql`UPDATE jobs SET status = 'failed', finished_at = now(),
                error = ${JSON.stringify({ message: 'Quota changed while reserving this generation.' })}
                WHERE id = ${job.id} AND status = 'running'`;
            return {
                status: 429,
                body: { code: 'QUOTA_EXCEEDED', error: 'A budget or quota limit would be exceeded.' },
            };
        }
    }

    // Forward to ModelArk, then attach the provider task id (or roll back the
    // slot + reservation if the provider rejected the request).
    let response;
    let data = null;
    let text = '';
    try {
        response = await fetch(targetUrl, { method: 'POST', headers, body });
        text = await response.text();
        try { data = JSON.parse(text); } catch { data = null; }

        // Seedance classifies the task from the PROMPT, server-side, after we
        // have sent it. If it decides the ask is video EDITING, the output
        // inherits the source clip's length and ratio - an edit cannot be
        // re-timed - so it rejects any fixed duration and demands -1.
        //
        // That verdict is not predictable from here: the identical request
        // shape, video reference included, is accepted with duration 5 when it
        // classifies as generation instead (verified against the live API). So
        // forcing -1 for every 2.5 request would wrongly strip duration control
        // from ordinary generation. React instead to the one unambiguous
        // signal - the provider naming the value it wants. One retry, only on
        // this exact complaint, and only when we sent something else.
        if (!response.ok && DURATION_MUST_BE_AUTO.test(text) && parsed?.duration !== AUTO_DURATION) {
            response = await fetch(targetUrl, {
                method: 'POST', headers, body: JSON.stringify({ ...parsed, duration: AUTO_DURATION }),
            });
            text = await response.text();
            try { data = JSON.parse(text); } catch { data = null; }
            if (response.ok) {
                console.log(`[byteplus] ${modelId} classified this as video editing - retried with duration=-1 (inherit from source)`);
            }
        }
    } catch (error) {
        if (job) await releaseProxyJob(gw, job.id, user, error.message);
        return { status: 502, body: { error: error.message } };
    }

    if (response.ok && data?.id) {
        data = { ...data, jobId: job?.id ?? null }; // MCP needs the gateway job id; data.id is the provider task id
        if (gw) {
            await gw.sql`UPDATE jobs SET provider_task_id = ${data.id} WHERE id = ${job.id}`;
            await emitEvent(gw.sql, { projectId: gw.project.id, userId: user.userId, type: 'job.status_changed', payload: { jobId: job.id, taskId: data.id, status: 'running' } });
        } else {
            await logUsage({
                userId: user.userId, email: user.email, modelId,
                resolution: parsed?.resolution ?? null,
                duration: typeof parsed?.duration === 'number' ? parsed.duration : null,
                ratio: parsed?.ratio ?? null,
                mode: mode || null,
                hasVideoInput: withVideo, taskId: data.id, estCostUsd: estUsd,
            }); // pre-migration fallback
        }
    } else if (job) {
        await releaseProxyJob(gw, job.id, user, data?.error?.message || `provider rejected (${response.status})`);
    }

    return data
        ? { status: response.status, body: data }
        : { status: response.status, body: { error: text.slice(0, 500) || response.statusText } };
}
