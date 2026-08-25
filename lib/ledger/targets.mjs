// The workbooks the ledger mirrors into.
//
// Two files, both driven from ledger_rows. This is safe in a way that two
// *exports* never were: the 90-minute drift between the two hand-built
// workbooks came from each one re-deriving the data independently. Two
// mirrors of one staging table cannot diverge — same rows, same session
// recomputation, same keys, same tick.
//
// Each target locks independently (someone can have the video workbook open
// while the master is closed), which is why sync state is keyed per target in
// ledger_sync rather than per row.
//
// Configured by environment so moving a workbook is a redeploy, not a code
// change. Resolve the three ids once with:
//     node --env-file=.env.local scripts/graph-locate-workbook.mjs <site> <path>

const TABLE_NAME = process.env.LEDGER_TABLE_NAME?.trim() || 'Ledger';

function target(id, { driveEnv, itemEnv, filter, label }) {
    const driveId = process.env[driveEnv]?.trim() || '';
    const itemId = process.env[itemEnv]?.trim() || '';
    return {
        id,
        label,
        driveId,
        itemId,
        tableName: TABLE_NAME,
        filter,
        configured: Boolean(driveId && itemId),
        missingEnv: [!driveId && driveEnv, !itemId && itemEnv].filter(Boolean),
    };
}

export function ledgerTargets() {
    return [
        target('master', {
            driveEnv: 'LEDGER_MASTER_DRIVE_ID',
            itemEnv: 'LEDGER_MASTER_ITEM_ID',
            label: 'logline-generations-master.xlsx',
            filter: () => true,
        }),
        target('video', {
            driveEnv: 'LEDGER_VIDEO_DRIVE_ID',
            itemEnv: 'LEDGER_VIDEO_ITEM_ID',
            label: 'video-generations-all-time.xlsx',
            filter: (row) => row.media === 'Video',
        }),
    ];
}

export function configuredTargets() {
    return ledgerTargets().filter((t) => t.configured);
}
