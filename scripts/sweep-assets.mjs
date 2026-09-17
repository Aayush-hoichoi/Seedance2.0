// Inspect and reclaim the shared BytePlus asset pool (it caps around 50 entries
// account-wide, so one busy afternoon fills it and everyone's uploads start
// failing).
//
// Run:  node --env-file=.env.local scripts/sweep-assets.mjs            # report only
//       node --env-file=.env.local scripts/sweep-assets.mjs --failed   # delete Failed assets
//       node --env-file=.env.local scripts/sweep-assets.mjs --age 30   # delete older than 30 min
//       node --env-file=.env.local scripts/sweep-assets.mjs --all      # delete EVERY studio asset
//
// Reports by default and deletes nothing. Both delete modes touch ONLY groups
// named "Seedance Studio…" — anything else in the account is someone's own
// library, or another product sharing the pool, and is never ours to clear.
//
// Age matters more than it looks: a submit needs its reference while ModelArk
// creates the task (launchJob retries run ~90s), so deleting a young asset can
// pull the ground out from under a job that is just starting. That has happened
// before. The app's own sweep uses ASSET_TTL_MINUTES, which is the floor here
// too — go lower only when you know nothing is in flight, and use --all for
// that rather than a number you will get wrong.

import { listGroups, listAssets, deleteAsset } from '../lib/byteplus/assetsServer.js';
import { ASSET_TTL_MINUTES } from '../lib/seedance/assetTtl.mjs';

const STUDIO_PREFIX = 'Seedance Studio';
const args = process.argv.slice(2);
const failedOnly = args.includes('--failed');
// --all ignores age entirely. That is the whole point of it and also its danger:
// a reference registered for a render that is still running goes with the rest,
// and that render then fails with "asset ... is not found". Only reach for it
// when you know nothing is in flight.
const all = args.includes('--all');
const ageArg = args.indexOf('--age');
const ageMin = ageArg >= 0 ? Number(args[ageArg + 1]) : null;

if (!all && ageMin !== null && (!Number.isFinite(ageMin) || ageMin < ASSET_TTL_MINUTES)) {
    console.error(`--age needs a number of minutes, and refuses anything under ${ASSET_TTL_MINUTES}:`);
    console.error('a shorter window deletes references out from under starting jobs.');
    process.exit(1);
}

const now = Date.now();
const ageOf = (a) => (a.createdAt ? Math.round((now - Date.parse(a.createdAt)) / 60000) : null);

const groups = await listGroups('AIGC');
const rows = [];
let total = 0;

for (const g of groups) {
    const assets = await listAssets(g.id, 'AIGC').catch((e) => {
        console.error(`  ! could not read "${g.name}": ${e.message}`);
        return [];
    });
    total += assets.length;
    if (assets.length) rows.push({ group: g.name, ours: g.name.startsWith(STUDIO_PREFIX), assets });
}

rows.sort((a, b) => b.assets.length - a.assets.length);

console.log(`\nPOOL: ${total} assets across ${rows.length} non-empty group(s) of ${groups.length}\n`);
console.log('ours?    n  oldest  newest  failed  group');
for (const r of rows) {
    const ages = r.assets.map(ageOf).filter((v) => v !== null);
    const failed = r.assets.filter((a) => a.status === 'Failed').length;
    console.log(
        `${r.ours ? 'SWEEP' : ' --  '} ${String(r.assets.length).padStart(4)}  ${String(Math.max(...ages, 0)).padStart(5)}m ${String(Math.min(...ages, 0)).padStart(6)}m ${String(failed).padStart(7)}  ${r.group}`,
    );
}

const ours = rows.filter((r) => r.ours);
const pick = (a) => {
    if (all) return true;
    if (failedOnly) return a.status === 'Failed';
    return ageOf(a) !== null && ageOf(a) > ageMin;
};

if (!all && !failedOnly && ageMin === null) {
    const failedTotal = ours.reduce((t, r) => t + r.assets.filter((a) => a.status === 'Failed').length, 0);
    const over60 = ours.reduce((t, r) => t + r.assets.filter((a) => (ageOf(a) ?? 0) > 60).length, 0);
    console.log(`\nReport only — nothing deleted.`);
    console.log(`  --failed    would free ${failedTotal} (a Failed asset can never be used again)`);
    console.log(`  --age 60    would free ${over60}`);
    console.log(`  --all       would free ${ours.reduce((t, r) => t + r.assets.length, 0)} — every studio asset, running jobs included`);
    process.exit(0);
}

// Groups this studio did not create are left alone in every mode. They belong
// to another product sharing the account, or to somebody's own library; clearing
// them is not this script's call to make.
const foreign = rows.filter((r) => !r.ours);
if (foreign.length) {
    const n = foreign.reduce((t, r) => t + r.assets.length, 0);
    console.log(`\nLeaving ${n} asset(s) in ${foreign.length} non-studio group(s) untouched: ${foreign.map((r) => r.group).join(', ')}`);
}

const doomed = ours.flatMap((r) => r.assets.filter(pick).map((a) => ({ ...a, group: r.group })));
const what = all ? 'of any age' : failedOnly ? 'with status Failed' : `older than ${ageMin} minutes`;
console.log(`\nDeleting ${doomed.length} studio asset(s) ${what}…\n`);

let freed = 0;
for (const a of doomed) {
    try {
        await deleteAsset(a.id);      // serialized through the write chain, so this paces itself
        freed += 1;
        console.log(`  deleted ${a.id}  ${String(ageOf(a)).padStart(4)}m  ${a.status || ''}  ${a.group}`);
    } catch (e) {
        console.error(`  FAILED  ${a.id}: ${e.message}`);
    }
}
console.log(`\nFreed ${freed} of ${doomed.length}. Pool now ~${total - freed}.`);
