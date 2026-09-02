// Route logic for issue reports, injected the same way as
// ./budgetRequestHandlers.mjs so this module stays network-free under
// `node --test`. `onCreated` is a post-commit side effect (the Teams card) and
// is deliberately never fatal: the report is already durably recorded by the
// time it runs.

const json = (body, init) => Response.json(body, init);

export function createIssueRouteHandler({ authenticate, createReport, onCreated = null }) {
    return async function POST(request) {
        const user = await authenticate();
        if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
        const body = await request.json().catch(() => null);
        const projectId = Number(body?.projectId);
        if (!Number.isInteger(projectId) || projectId <= 0) {
            return json({ error: 'A valid project is required.' }, { status: 400 });
        }
        try {
            const result = await createReport({ projectId, user, report: body });
            // Not an error: the admin already has this exact card. Telling the
            // user "already reported" beats sending a duplicate or failing.
            if (result?.duplicate) return json({ ok: true, duplicate: true }, { status: 200 });
            if (onCreated) {
                try { await onCreated(result); } catch (err) { console.error('[issue] onCreated failed:', err?.message); }
            }
            return json({ ok: true, ...result }, { status: 201 });
        } catch (error) {
            const status = /member/.test(error.message)
                ? 403
                : /unavailable/.test(error.message) || error?.code
                    ? 503
                    : 400;
            return json({ error: error.message || 'Could not send the report.' }, { status });
        }
    };
}

export function createMyIssuesRouteHandler({ authenticate, listDecisions }) {
    return async function GET() {
        const user = await authenticate();
        if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
        try {
            return json({ decisions: await listDecisions({ userId: user.userId }) });
        } catch {
            // Replay is best-effort — an empty list must never break studio load.
            return json({ decisions: [] });
        }
    };
}

export function createIssueDecisionRouteHandler({ authenticate, canReview, decideReport }) {
    return async function POST(request, { params }) {
        const admin = await authenticate();
        if (!canReview(admin)) return json({ error: 'Forbidden' }, { status: 403 });
        const { id, action } = await params;
        if (!['resolve', 'dismiss'].includes(action)) return json({ error: 'Unknown action.' }, { status: 400 });
        const body = await request.json().catch(() => ({}));
        try {
            const result = await decideReport({ id, action, admin, note: body?.note });
            if (result.error === 'not_found') return json({ error: 'Issue not found.' }, { status: 404 });
            if (result.error === 'decided') return json({ error: 'This issue was already closed.' }, { status: 409 });
            return json(result);
        } catch (error) {
            return json({ error: error.message || 'Could not close the issue.' }, { status: 500 });
        }
    };
}
