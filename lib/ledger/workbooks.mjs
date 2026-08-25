// The two workbooks, reproduced exactly.
//
//   logline-generations-master.xlsx  — 4 sheets, 41 columns, both media, no
//                                      hyperlinks (URLs are plain text)
//   video-generations-all-time.xlsx  — 8 sheets, 45 columns, video only, with
//                                      hyperlinks and four roll-up tabs
//
// Both are projections of the same canonical rows. Nothing here re-derives a
// value; it picks columns, groups, and counts. That is the whole reason the
// canonical shape carries both files' vocabularies (see columns.mjs) — if this
// module had to translate, the two exports could drift apart, which is exactly
// what happened to the hand-built files 90 minutes after they were made.

import {
    MASTER_COLUMNS, VIDEO_COLUMNS, MASTER_REF_COLUMNS, VIDEO_REF_COLUMNS,
    AGGREGATE_COLUMNS, projectRow, NO_DURABLE_KEY, NOT_RECORDED,
} from './columns.mjs';
import { ACCEPTANCE_BASIS } from './sessions.mjs';
import { refLink, refName, refRole, refDurableKey } from './shape.mjs';

const SUCCEEDED = 'succeeded';

// --- reference assets ---------------------------------------------------------

// One row per reference asset, in the order they were attached. Both files
// carry this as its own sheet; the master adds a Media column, the video file
// links the filename and spells out a missing key.
function referenceRows(rows, { media = false } = {}) {
    const out = [];
    for (const row of rows) {
        const refs = Array.isArray(row.input_refs) ? row.input_refs : [];
        refs.forEach((ref, i) => {
            const base = {
                'Task ID': row.task_id || '',
                'Date (IST)': row.cells['Date (IST)'],
                User: row.user_name || NOT_RECORDED,
                'Ref #': i + 1,
                Role: refRole(ref),
                'File Name': refName(ref),
                'Asset ID': ref?.assetId || ref?.id || '',
            };
            if (media) {
                out.push({
                    ...base,
                    Media: row.media,
                    'Durable Key': refDurableKey(ref),
                    Link: refLink(ref),
                    'Prompt (exact)': row.cells['PROMPT (exact)'],
                });
            } else {
                out.push({
                    ...base,
                    // The video workbook shows the filename and hangs the URL
                    // off it, and says so plainly when there is no durable copy.
                    '▶ OPEN REF': refLink(ref) ? refName(ref) : '',
                    'Durable Key': refDurableKey(ref) || NO_DURABLE_KEY,
                    'PROMPT (exact)': row.cells['PROMPT (exact)'],
                });
            }
        });
    }
    return out;
}

// --- roll-ups -----------------------------------------------------------------

function percent(part, whole) {
    if (!whole) return '0%';
    const value = (part / whole) * 100;
    // The workbook prints one decimal, but drops it on a whole number: "100%",
    // not "100.0%".
    return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

// Costs are numeric(10,4) in Postgres, so they are exact there and only become
// approximate once they are JavaScript floats. Accumulating in ten-thousandths
// as integers keeps a 9,000-row sum exact instead of letting it drift a cent at
// a time, and makes the 2-decimal rounding land where a human expects — plain
// `Math.round(1.005 * 100) / 100` is 1, not 1.01, because 1.005 has no exact
// binary representation.
const SCALE = 10_000;

function toTenThousandths(value) {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? Math.round(n * SCALE) : 0;
}

function centsToUsd(scaled) {
    return Math.round(scaled / 100) / 100;
}

// Group rows and count them the way the four roll-up tabs do. "Archive
// Confirmed" counts rows whose storage key was actually written back, not rows
// whose key is merely derivable.
function aggregate(rows, keyColumn, keyOf) {
    const groups = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (!groups.has(key)) {
            groups.set(key, {
                [keyColumn]: key,
                Generations: 0, Succeeded: 0, Failed: 0,
                Downloaded: 0, 'Archive Confirmed': 0, cost: 0,
            });
        }
        const g = groups.get(key);
        g.Generations += 1;
        if (row.status === SUCCEEDED) g.Succeeded += 1;
        // "Failed" is the failed status specifically, not "everything that did
        // not succeed" — queued and running rows belong to neither column.
        if (row.status === 'failed') g.Failed += 1;
        if (Number(row.downloads || 0) > 0) g.Downloaded += 1;
        if (row.output_confirmed) g['Archive Confirmed'] += 1;
        // Sum the rendered cost, not the raw columns — a failure settles to 0,
        // and summing its estimate instead would inflate every roll-up.
        g.cost += toTenThousandths(row.cells?.['Cost (USD)'] ?? 0);
    }
    return [...groups.values()]
        .map((g) => ({
            [keyColumn]: g[keyColumn],
            Generations: g.Generations,
            Succeeded: g.Succeeded,
            Failed: g.Failed,
            'Success Rate': percent(g.Succeeded, g.Generations),
            Downloaded: g.Downloaded,
            'Archive Confirmed': g['Archive Confirmed'],
            'Total Cost (USD)': centsToUsd(g.cost),
        }))
        .sort((a, b) => b.Generations - a.Generations);
}

const userLabel = (row) => (row.user_email
    ? `${row.user_name || 'Unknown'} <${row.user_email}>`
    : NOT_RECORDED);

// --- the method / storage narrative sheets ------------------------------------

function pair(item, detail) {
    return { Item: item, Detail: detail };
}

function methodSheet(rows, refRowCount, linkableRefs, snapshot) {
    const withKey = rows.filter((r) => r.cells['Output Key']).length;
    const downloaded = rows.filter((r) => Number(r.downloads || 0) > 0).length;
    return [
        pair('Source', 'Production Neon database — jobs, seedance_prompts, generation_events, billing_events, users, projects. Read-only.'),
        pair('Snapshot', snapshot),
        pair('Rows', `${rows.length} generations (all-time, both eras). Sheet 3 lists ${refRowCount} individual reference assets.`),
        pair('Timezone', 'IST (UTC+5:30).'),
        pair('', ''),
        pair('PROMPT (exact)', 'Verbatim. For video this is seedance_prompts.user_prompt (what the person typed); "Enhanced Prompt" is the enhancer output actually sent to the model. For images it is jobs.request_body.prompt.'),
        pair('REFERENCE ASSETS', `The assets tagged to that prompt, with role, original filename and durable TOS key. ${linkableRefs} of ${refRowCount} reference assets carry a durable key (uploads/...) and are linkable.`),
        pair('Image references', 'NOT LINKABLE. Image-mode references are downscaled and stored as base64 inside jobs.request_body.parts — they were never written to object storage, so no durable key or link exists for any of them.'),
        pair('OUTPUT LINK', 'Points at /api/byteplus/archive?key=… which returns a fresh signed URL for a signed-in user and never expires. Supply working ARK_AK / ARK_SK and this export regenerates with direct 7-day media links.'),
        pair('Output Key', 'The permanent object identity: videos/<taskId>.mp4 or images/job-<id>-<i>.<ext>. Valid forever regardless of link expiry.'),
        pair('Output Stored?', 'Confirmed = the job row records the storage key. Unconfirmed = no key recorded; the object may still exist (the browser archive path writes the object without recording the key). In Postgres = the model returned base64 inline and nothing was written to object storage.'),
        pair('', ''),
        pair('DOWNLOADED?', `Recorded fact, from generation_events. ${downloaded} generations were downloaded.`),
        pair('Download coverage — VIDEO', 'Recorded from 2026-07-26 onward only. Anything downloaded before that date shows "no" because the event table did not exist yet.'),
        pair('Download coverage — IMAGE', 'ZERO image downloads exist in the system. generation_events contains no rows for image task ids (job:<id>) — download tracking was never wired up for images. Every image row therefore shows "no", which means "not tracked", not "not downloaded".'),
        pair('Liked? / Binned?', 'From seedance_prompts (video) and generation_events. Same coverage caveats as downloads.'),
        pair('', ''),
        pair('Session ID / Try #', 'Derived. A new session starts when the user, project or media type changes, more than 45 minutes pass, or prompt token-set similarity to the session anchor falls below 0.50.'),
        pair('Accepted Output', 'Where a download exists it is the recorded fact ("Recorded" confidence). Otherwise it is inferred as the last successful try in the session — High (only success), Medium (2-5), Low (more than 5).'),
        pair('Pre-gateway rows', 'Era "Pre-gateway" (2026-06-12 to 2026-07-11) predates the jobs table: user, model, status and cost were never recorded. Prompt, references and the deterministic output key ARE available.'),
        pair('', ''),
        pair('Totals — generations', String(rows.length)),
        pair('Totals — with an output key', `${withKey} (${percent(withKey, rows.length)})`),
        pair('Totals — downloaded', `${downloaded} (${percent(downloaded, rows.length)})`),
        pair('Totals — reference assets', `${refRowCount}, of which ${linkableRefs} linkable`),
    ];
}

function storageGuideSheet(rows, refRowCount, linkableRefs, bucket, region) {
    const confirmed = rows.filter((r) => r.output_confirmed).length;
    const notArchived = rows.filter((r) => !r.cells['Output Key']).length;
    const expected = rows.length - confirmed - notArchived;
    const downloaded = rows.filter((r) => Number(r.downloads || 0) > 0).length;
    return [
        pair('Storage service', 'BytePlus TOS (object storage), same account that runs the models.'),
        pair('Bucket', bucket),
        pair('Region / endpoint', `tos-${region}.bytepluses.com  (${region})`),
        pair('Key pattern for videos', 'videos/<providerTaskId>.mp4 — the ModelArk task id with non [A-Za-z0-9._-] characters replaced by underscore.'),
        pair('Full URL pattern', `https://${bucket}.tos-${region}.bytepluses.com/videos/<providerTaskId>.mp4`),
        pair('Are objects public?', 'No. The bucket is private — the Full Storage URL is the exact location, but opening it raw returns 403. Reads need a signature.'),
        pair('', ''),
        pair('▶ OPEN VIDEO', 'Opens /api/byteplus/archive?key=… which returns a fresh signed URL as JSON for a signed-in user.'),
        pair('To get one-click video', 'Supply a working ARK_AK / ARK_SK from the production environment and re-export. Every row becomes a direct 7-day video link.'),
        pair('STORAGE STATE — Confirmed', `${confirmed} rows. jobs.result.video_key is set, so the server archived the file and recorded the key. These are certain.`),
        pair('STORAGE STATE — Expected', `${expected} rows. The task id is known, so the key is derived deterministically (videos/<taskId>.mp4), but no key was written back.`),
        pair('STORAGE STATE — Not archived', `${notArchived} rows. The generation never reached the provider, so no video was ever produced. Nothing to store.`),
        pair('Provider URL', 'jobs.result.video_url holds the original ModelArk link. It expires ~24 hours after generation, so it is marked "stored (expired)" rather than reproduced.'),
        pair('', ''),
        pair('REFERENCE ASSETS', `The assets tagged to each prompt. ${linkableRefs} of ${refRowCount} carry a durable uploads/... key and are linkable; the rest were registered only into the BytePlus Asset Library, which sweeps its objects after about an hour.`),
        pair('', ''),
        pair('DOWNLOADED?', `Recorded fact from generation_events. ${downloaded} videos were downloaded. IMPORTANT: this table only starts on 2026-07-26 — anything downloaded before that date reads "no" because the event log did not exist yet.`),
        pair('Accepted Output', 'Where a download exists it is a recorded fact ("Recorded"). Otherwise inferred as the last successful try in the session — High (only success), Medium (2-5), Low (more than 5).'),
        pair('Session ID / Try #', 'Derived. A new session starts when the user or project changes, more than 45 minutes pass, or prompt token-set similarity to the session anchor drops below 0.50. Pre-gateway rows show "—" because they carry no user.'),
        pair('Pre-gateway rows', 'Era "Pre-gateway" (2026-06-12 to 2026-07-11) predates the jobs table: user, model, status, settings and cost were never recorded. Prompt, references and the deterministic storage key ARE available.'),
        pair('', ''),
        pair('Totals — video generations', String(rows.length)),
        pair('Totals — archive confirmed', `${confirmed} (${percent(confirmed, rows.length)})`),
        pair('Totals — archive unconfirmed', `${expected} (${percent(expected, rows.length)})`),
        pair('Totals — downloaded', String(downloaded)),
        pair('Totals — reference assets', `${refRowCount}, of which ${linkableRefs} linkable`),
    ];
}

// --- the workbooks ------------------------------------------------------------

const isDownloaded = (row) => Number(row.downloads || 0) > 0;

/**
 * logline-generations-master.xlsx — every generation, both media.
 * `rows` are shaped rows: { ...ledger row, cells } after computeSessions.
 */
export function masterWorkbook(rows, { snapshot = new Date().toISOString() } = {}) {
    // The one string the two files disagree on. Rewritten here rather than in
    // sessions.mjs so the canonical row keeps a single wording.
    const cellsFor = (row) => {
        const cells = projectRow(row.cells, MASTER_COLUMNS);
        if (cells['Acceptance Basis'] === ACCEPTANCE_BASIS.NO_SUCCESS) {
            cells['Acceptance Basis'] = ACCEPTANCE_BASIS.NO_SUCCESS_MASTER;
        }
        return cells;
    };

    const all = rows.map(cellsFor);
    const downloaded = rows.filter(isDownloaded).map(cellsFor);
    const refs = referenceRows(rows, { media: true });
    const linkable = refs.filter((r) => r['Durable Key']).length;

    return [
        { name: 'All Generations', columns: MASTER_COLUMNS, rows: all },
        { name: 'Downloaded Only', columns: MASTER_COLUMNS, rows: downloaded },
        { name: 'Reference Assets', columns: MASTER_REF_COLUMNS, rows: refs },
        {
            name: 'Method & Caveats',
            columns: ['Item', 'Detail'],
            rows: methodSheet(rows, refs.length, linkable, snapshot),
        },
    ];
}

/**
 * video-generations-all-time.xlsx — video only, with roll-ups and hyperlinks.
 * `rows` must already be filtered to video.
 */
export function videoWorkbook(rows, { bucket, region } = {}) {
    const all = rows.map((row) => projectRow(row.cells, VIDEO_COLUMNS));
    const downloaded = rows.filter(isDownloaded).map((row) => projectRow(row.cells, VIDEO_COLUMNS));
    const refs = referenceRows(rows, { media: false });
    const linkable = refs.filter((r) => r['Durable Key'] !== NO_DURABLE_KEY).length;

    // Display text stays as the workbook shows it; the URL rides along as a
    // relationship. Keyed by row so a lookup never depends on cell order.
    const urlByOpenLabel = new Map(rows.map((row) => [row.cells['Task ID'], row.cells['Full Storage URL']]));
    const links = {
        '▶ OPEN VIDEO': (row) => urlByOpenLabel.get(row['Task ID']) || '',
        'Full Storage URL': (row) => row['Full Storage URL'] || '',
    };
    for (let i = 1; i <= 6; i += 1) {
        links[`Ref ${i} Link`] = (row) => row[`Ref ${i} Link`] || '';
    }

    const refUrl = new Map();
    for (const row of rows) {
        const list = Array.isArray(row.input_refs) ? row.input_refs : [];
        list.forEach((ref, i) => refUrl.set(`${row.task_id}#${i + 1}`, refLink(ref)));
    }

    return [
        { name: 'Video Generations', columns: VIDEO_COLUMNS, rows: all, links },
        { name: 'Downloaded Only', columns: VIDEO_COLUMNS, rows: downloaded, links },
        {
            name: 'Reference Assets',
            columns: VIDEO_REF_COLUMNS,
            rows: refs,
            links: { '▶ OPEN REF': (row) => refUrl.get(`${row['Task ID']}#${row['Ref #']}`) || '' },
        },
        { name: 'By User', columns: ['User', ...AGGREGATE_COLUMNS], rows: aggregate(rows, 'User', userLabel) },
        { name: 'By Model', columns: ['Model', ...AGGREGATE_COLUMNS], rows: aggregate(rows, 'Model', (r) => r.model_id || NOT_RECORDED) },
        { name: 'By Project', columns: ['Project', ...AGGREGATE_COLUMNS], rows: aggregate(rows, 'Project', (r) => r.project_name || NOT_RECORDED) },
        { name: 'By Date', columns: ['Date (IST)', ...AGGREGATE_COLUMNS], rows: aggregate(rows, 'Date (IST)', (r) => r.cells['Date (IST)']) },
        {
            name: 'Storage Guide',
            columns: ['Item', 'Detail'],
            rows: storageGuideSheet(rows, refs.length, linkable, bucket, region),
        },
    ];
}

export { aggregate, referenceRows, percent };
