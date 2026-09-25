// Manual trigger for the nightly workflow self-refresh (workflowRefresh.mjs):
// folds recently LIKED generations back into each workflow's style as a new,
// audited version. The daily cron does this automatically; run this to force
// a refresh now.
//
// Usage: node --env-file=.env.local scripts/refresh-workflow-styles.mjs

import { neon } from '@neondatabase/serverless';
import { refreshWorkflowStyles } from '../lib/gateway/workflowRefresh.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const summary = await refreshWorkflowStyles(neon(url));
for (const row of summary) {
    const outcome = row.updated ? `updated (${row.updated})`
        : row.unchanged ? 'no new pattern — unchanged'
        : row.skipped ? `skipped: ${row.skipped}`
        : row.rejected ? `REJECTED: ${row.rejected}`
        : `FAILED: ${row.failed}`;
    console.log(`${row.name}: ${outcome}`);
}
