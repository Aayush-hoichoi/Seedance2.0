import { applicableQuotas, quotaBalances, windowBounds } from '../gateway/quota.mjs';

const json = (body, init) => Response.json(body, init);

export function createBudgetRequestRouteHandlers({ authenticate, loadContext, createRequest }) {
    return {
        async GET(request) {
            const user = await authenticate();
            if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
            const projectId = Number(new URL(request.url).searchParams.get('projectId'));
            if (!Number.isInteger(projectId) || projectId <= 0) {
                return json({ error: 'A valid project is required.' }, { status: 400 });
            }
            try {
                const context = await loadContext({ projectId, user });
                if (!context) return json({ error: 'You are not a member of that project.' }, { status: 403 });
                return json(context);
            } catch (error) {
                return json({ error: error.message || 'Could not load budget details.' }, { status: 503 });
            }
        },

        async POST(request) {
            const user = await authenticate();
            if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
            const body = await request.json().catch(() => null);
            const projectId = Number(body?.projectId);
            if (!Number.isInteger(projectId) || projectId <= 0) {
                return json({ error: 'A valid project is required.' }, { status: 400 });
            }
            try {
                const result = await createRequest({
                    projectId, user, modelId: body?.modelId, quality: body?.quality,
                    increaseAmount: body?.increaseAmount, reason: body?.reason,
                });
                return json({ ok: true, ...result }, { status: 201 });
            } catch (error) {
                const status = /member/.test(error.message)
                    ? 403
                    : /unavailable/.test(error.message) || error?.code
                        ? 503
                        : 400;
                return json({ error: error.message || 'Could not send the request.' }, { status });
            }
        },
    };
}

export function createBudgetDecisionRouteHandler({ authenticate, canReview, decideRequest }) {
    return async function POST(request, { params }) {
        const admin = await authenticate();
        if (!canReview(admin)) return json({ error: 'Forbidden' }, { status: 403 });
        const { id, action } = await params;
        if (!['approve', 'deny'].includes(action)) return json({ error: 'Unknown action.' }, { status: 400 });
        const body = await request.json().catch(() => ({}));
        try {
            const result = await decideRequest({ id, action, admin, policy: body?.policy, reason: body?.reason });
            if (result.error === 'not_found') return json({ error: 'Request not found.' }, { status: 404 });
            if (result.error === 'decided') return json({ error: 'This request was already decided.' }, { status: 409 });
            if (result.error === 'limit') return json({ error: 'The resulting budget limit must be greater than zero.' }, { status: 400 });
            if (result.error === 'policy') return json({ error: 'Select either a soft or hard limit policy.' }, { status: 400 });
            if (result.error === 'model_inactive') return json({ error: 'The requested model is no longer active.' }, { status: 409 });
            return json(result);
        } catch (error) {
            return json({ error: error.message || 'Could not decide the request.' }, { status: 500 });
        }
    };
}

export function createMyBudgetRouteHandler({ authorize, loadActiveQuotas, loadUsage }) {
    return async function GET(request) {
        const url = new URL(request.url);
        const projectId = Number(url.searchParams.get('projectId')) || null;
        if (!projectId) return json({ code: 'BAD_REQUEST', message: 'projectId is required.' }, { status: 400 });

        const auth = await authorize({ projectId });
        if (!auth.ok) return auth.response;
        const { sql, user } = auth.ctx;
        const requestedModelId = url.searchParams.get('modelId')?.trim() || null;
        let modelId = null;
        if (requestedModelId) {
            const [model] = await sql`SELECT DISTINCT m.id FROM models m
                LEFT JOIN model_versions v ON v.model_id = m.id
                WHERE m.active = true AND (m.id = ${requestedModelId} OR v.version_tag = ${requestedModelId})
                LIMIT 1`;
            modelId = model?.id ?? requestedModelId;
        }

        const quotas = applicableQuotas(await loadActiveQuotas(sql), {
            projectId, userId: user.userId, modelId,
        }).filter((quota) => quota.type === 'usd');
        const usage = await loadUsage(sql, quotas);
        const [binding] = quotaBalances({ quotas, projectId, userId: user.userId, modelId, ...usage });
        if (!binding) return json({ budget: null });

        const { quota, limit, used, reserved, remaining } = binding;
        const scope = quota.user_id && quota.model_id
            ? 'your model budget'
            : quota.user_id ? 'your budget'
                : quota.model_id ? 'model budget'
                    : quota.project_id ? 'project budget' : 'workspace budget';
        return json({
            budget: {
                remaining, limit, used, reserved, window: quota.window, scope,
                modelId: quota.model_id ?? null,
                resetsAt: windowBounds(quota.window, new Date()).resetsAt?.toISOString() ?? null,
            },
        });
    };
}
