// Resolve a SharePoint workbook's driveId + itemId — the two values the ledger
// writer needs in the environment. Run once per workbook, after the files have
// been moved to a document library and the app has been granted Sites.Selected
// write on that site.
//
//   node --env-file=.env.local scripts/graph-locate-workbook.mjs \
//        hoichoitech.sharepoint.com /sites/LoglineAI "Ledger/logline-generations-master.xlsx"
//
// A 403 here almost always means the site-level grant is missing: Sites.Selected
// is consent to be granted access, not access itself — an admin still has to
// assign the app to this specific site.

import { resolveWorkbook, graphToken, GraphError } from '../lib/graph/workbook.mjs';

const [hostname, sitePath, filePath] = process.argv.slice(2);

if (!hostname || !sitePath || !filePath) {
    console.error('usage: graph-locate-workbook.mjs <hostname> <site-path> <file-path-in-library>');
    console.error('   eg: graph-locate-workbook.mjs hoichoitech.sharepoint.com /sites/LoglineAI "Ledger/master.xlsx"');
    process.exit(1);
}

for (const name of ['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID']) {
    if (!process.env[name]?.trim()) {
        console.error(`${name} is not set — the ledger reuses the Teams app registration for Graph.`);
        process.exit(1);
    }
}

try {
    await graphToken();
} catch (err) {
    console.error(`Could not get a Graph token: ${err.message}`);
    console.error('Check that the Entra app has Microsoft Graph → Application → Sites.Selected with admin consent.');
    process.exit(1);
}

try {
    const found = await resolveWorkbook({ hostname, sitePath, filePath });
    console.log(`Found ${found.name} (${(found.size / 1_048_576).toFixed(1)} MB)\n`);
    console.log(`  siteId  ${found.siteId}`);
    console.log(`  driveId ${found.driveId}`);
    console.log(`  itemId  ${found.itemId}\n`);
    console.log('Add to .env.local (pick the matching pair):\n');
    console.log(`LEDGER_MASTER_DRIVE_ID=${found.driveId}`);
    console.log(`LEDGER_MASTER_ITEM_ID=${found.itemId}`);
    console.log('# or');
    console.log(`LEDGER_VIDEO_DRIVE_ID=${found.driveId}`);
    console.log(`LEDGER_VIDEO_ITEM_ID=${found.itemId}`);
    process.exit(0);
} catch (err) {
    console.error(`Lookup failed: ${err.message}`);
    if (err instanceof GraphError && err.status === 403) {
        console.error('\n403 — the app has Sites.Selected but has not been assigned to this site. An admin must run:');
        console.error(`  POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions`);
        console.error(`  { "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "${process.env.TEAMS_APP_ID}" } }] }`);
    }
    process.exit(1);
}
