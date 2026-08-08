import { gatewayContext } from '../../../../lib/gateway/authz.js';
import { activeQuotas, usageForQuotas } from '../../../../lib/gateway/db.js';
import { createMyBudgetRouteHandler } from '../../../../lib/http/budgetRequestHandlers.mjs';

export const runtime = 'nodejs';

export const GET = createMyBudgetRouteHandler({
    authorize: gatewayContext,
    loadActiveQuotas: activeQuotas,
    loadUsage: usageForQuotas,
});
