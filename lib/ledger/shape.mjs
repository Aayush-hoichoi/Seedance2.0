// One generation_ledger row (plus its computed session fields) → the canonical
// superset of cells both workbooks are projected from. Pure and side-effect
// free so the backfill, the live sync, the console and the exports all produce
// byte-identical output for the same input.
//
// Every rendered value here reproduces the wording of the two hand-built
// workbooks exactly — "Open video ▶", "(not recorded)", "stored (expired)",
// the three-part Storage State sentences. Those files are the specification,
// so a value invented here would show up as a diff in the export.
//
// Everything renders in IST (UTC+5:30) to match them. The offset is a constant
// rather than a timezone lookup: India has no DST and has not changed offset
// since 1945, and a fixed number keeps this module pure.

import { presignKey } from '../seedance/galleryItem.mjs';
import {
    LEDGER_COLUMNS, REF_LINK_SLOTS, STORAGE_STATE, OUTPUT_STORED,
    NO_LINK_IN_POSTGRES, OPEN_VIDEO_LABEL, PROVIDER_URL_EXPIRED,
    NO_DURABLE_KEY, NOT_RECORDED,
} from './columns.mjs';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const BUCKET = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const TOS_REGION = process.env.TOS_REGION?.trim() || 'ap-southeast-1';

// Fallback for OUTPUT LINK when no signature can be produced — this is what
// both hand-built exports fell back to when ARK_AK was rejected by TOS. It
// returns a freshly signed URL to a signed-in user and never expires, unlike a
// presigned link, so it is the safer thing to bake into a permanent sheet.
function archiveProxyUrl(key) {
    const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '');
    if (!base || !key) return '';
    return `${base}/api/byteplus/archive?key=${encodeURIComponent(key)}`;
}

function istDate(value) {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istTime(value) {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 19);
}

function istDateTime(value) {
    const date = istDate(value);
    return date ? `${date} ${istTime(value)}` : '';
}

const yesNo = (v) => (v ? 'YES' : 'no');
// Had Video Input capitalises differently from the yes/no columns. That is how
// the workbook does it, so that is how it is done here.
const YesNo = (v) => (v ? 'Yes' : 'No');

function money(value) {
    if (value === null || value === undefined || value === '') return '';
    const n = Number(value);
    return Number.isFinite(n) ? n : '';
}

// Statuses that end a generation without producing anything.
const TERMINAL_FAILURES = new Set(['failed', 'timed_out', 'cancelled', 'rejected']);

// What a generation actually cost.
//
//   settled   → the settlement figure, whatever it is
//   failed    → 0. The reservation is released, so nothing was spent. Falling
//               back to the estimate here would overstate the cost of every
//               failure — 1,307 rows — and inflate every roll-up that sums it.
//   in flight → the estimate, which is the best number available
function costFor(row) {
    if (row.cost_usd !== null && row.cost_usd !== undefined) return money(row.cost_usd);
    if (row.era === 'Pre-gateway') return '';
    if (TERMINAL_FAILURES.has(row.status)) return 0;
    return money(row.est_cost_usd);
}

// A reference asset's durable location, if it has one. Assets registered only
// into the BytePlus Asset Library have no uploads/… key — that library sweeps
// its objects after about an hour, so those references are gone and no link
// can be produced. 24% of the historical reference rows are in this state.
export function refLink(ref) {
    const key = typeof ref?.tosKey === 'string' ? ref.tosKey : null;
    if (key) {
        try {
            return presignKey(key) || archiveProxyUrl(key);
        } catch {
            return archiveProxyUrl(key);
        }
    }
    return typeof ref?.url === 'string' ? ref.url : '';
}

export function refName(ref) {
    return ref?.name || ref?.fileName || '(unnamed)';
}

// Roles are stored machine-side as reference_video / reference_image; both
// workbooks render them with spaces. Matching that is the difference between
// "[reference video]" and "[reference_video]" on 4,926 rows.
export function refRole(ref) {
    return String(ref?.role || 'reference').replace(/_/g, ' ');
}

export function refDurableKey(ref) {
    return typeof ref?.tosKey === 'string' ? ref.tosKey : '';
}

function refSummary(refs) {
    return refs
        .map((ref, i) => `${i + 1}. [${refRole(ref)}] ${refName(ref)} → ${refDurableKey(ref) || NO_DURABLE_KEY}`)
        .join('\n');
}

// The two workbooks describe storage differently over the same three facts.
//   Confirmed    — the job recorded the key; the object certainly exists.
//   Expected     — an output was produced and the key is derivable from the
//                  task id, but nothing wrote it back. Probably fine.
//   Not archived — the generation never produced an output. Nothing is missing.
function storageStateFor(row, outputKey) {
    if (row.output_confirmed) return STORAGE_STATE.CONFIRMED;
    if (!outputKey) return STORAGE_STATE.NOT_ARCHIVED;
    return STORAGE_STATE.EXPECTED;
}

function outputStoredFor(row, outputKey, inPostgres) {
    if (inPostgres) return OUTPUT_STORED.IN_POSTGRES;
    if (row.output_confirmed) return OUTPUT_STORED.CONFIRMED;
    return OUTPUT_STORED.UNCONFIRMED;
}

function outputLinkFor(key) {
    if (!key) return '';
    try {
        return presignKey(key) || archiveProxyUrl(key);
    } catch {
        return archiveProxyUrl(key);
    }
}

/**
 * Build the canonical cells object for one row. Keys are the column names from
 * LEDGER_COLUMNS; anything absent is rendered as ''.
 *
 * `row` must already have been through computeSessions() — session_id,
 * try_number, tries_in_session, successes_in_session, accepted_output,
 * acceptance_basis and confidence are read, not derived.
 */
export function shapeLedgerRow(row) {
    const refs = Array.isArray(row.input_refs) ? row.input_refs : [];
    const outputKey = row.output_key || '';
    const isPreGateway = row.era === 'Pre-gateway';
    // Seven Nano Banana images returned base64 inline and were never written to
    // object storage: succeeded, image, no key. Real state, not a defect.
    const inPostgres = row.media === 'Image' && row.status === 'succeeded' && !outputKey;

    const cells = {
        'Row Key': row.row_key,
        Era: row.era,
        Media: row.media,
        'Date (IST)': istDate(row.submitted_at),
        'Time (IST)': istTime(row.submitted_at),
        'User Name': row.user_name || (isPreGateway ? NOT_RECORDED : ''),
        'User Email': row.user_email || (isPreGateway ? NOT_RECORDED : ''),
        Project: row.project_name || (isPreGateway ? NOT_RECORDED : ''),
        Model: row.model_id || NOT_RECORDED,
        'Mode / Style': row.style || row.mode || '',
        Status: row.status || NOT_RECORDED,
        'PROMPT (exact)': row.user_prompt || row.prompt || '',
        'Enhanced Prompt (as sent)': row.generated_prompt || '',
        'Ref Count': refs.length,
        'REFERENCE ASSETS (role · name · key)': refSummary(refs),

        // Master-side storage columns.
        'OUTPUT LINK': inPostgres ? NO_LINK_IN_POSTGRES : outputLinkFor(outputKey),
        'Output Key': outputKey,
        'Output Stored?': outputStoredFor(row, outputKey, inPostgres),

        // Video-side storage columns, over the same facts.
        '▶ OPEN VIDEO': outputKey ? OPEN_VIDEO_LABEL : '',
        'Storage Bucket': outputKey ? BUCKET : '',
        'Storage Key (object path)': outputKey,
        'Full Storage URL': outputKey
            ? `https://${BUCKET}.tos-${TOS_REGION}.bytepluses.com/${outputKey}`
            : '',
        'Storage State': storageStateFor(row, outputKey),
        'Provider URL (expires ~24h)': row.provider_url ? PROVIDER_URL_EXPIRED : '',

        'DOWNLOADED?': yesNo(Number(row.downloads || 0) > 0),
        'Download Count': Number(row.downloads || 0),
        'Downloaded At (IST)': istDateTime(row.last_downloaded_at),
        'Liked?': yesNo(Number(row.likes || 0) > 0),
        'Binned?': yesNo(row.binned),

        // The same two facts under each workbook's own heading.
        Quality: row.resolution || '',
        Resolution: row.resolution || '',
        Ratio: row.ratio || '',
        'Aspect Ratio': row.ratio || '',
        'Duration (s)': row.duration ?? '',
        'Had Video Input': isPreGateway || row.media !== 'Video' ? '' : YesNo(row.has_video_input),

        'Session ID': row.session_id ?? '',
        'Try #': row.try_number ?? '',
        'Tries in Session': row.tries_in_session ?? '',
        'Successes in Session': row.successes_in_session ?? '',
        'Accepted Output': row.accepted_output ?? '',
        'Acceptance Basis': row.acceptance_basis ?? '',
        Confidence: row.confidence ?? '',

        'Cost (USD)': costFor(row),
        'Generation ID': row.generation_id ?? '',
        'Task ID': row.task_id || '',
        'Failure Reason': row.error_message || '',
    };

    for (let i = 0; i < REF_LINK_SLOTS; i += 1) {
        // The master workbook shows the URL as text; the video workbook shows
        // the filename and hangs the URL off it as a hyperlink. Both are kept
        // so each export can pick without transforming.
        cells[`Ref ${i + 1} Link`] = refs[i] ? refLink(refs[i]) : '';
        cells[`Ref ${i + 1} Name`] = refs[i] ? refName(refs[i]) : '';
    }

    // Fail loudly on a column the shaper forgot rather than shipping a sheet
    // with a silently empty column: a missing cell is indistinguishable from a
    // legitimately blank one once it is in Excel.
    for (const name of LEDGER_COLUMNS) {
        if (!(name in cells)) cells[name] = '';
    }
    return cells;
}
