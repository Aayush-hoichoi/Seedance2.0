// The ledger's column contract.
//
// Two shapes exist and both matter:
//
//   MASTER_COLUMNS / VIDEO_COLUMNS — the EXACT headers of the two hand-built
//   workbooks, in their exact order and wording. These are not a design; they
//   are a specification recovered from the files, and the exports reproduce
//   them character for character so a person opening a download cannot tell it
//   apart from the file they already know.
//
//   LEDGER_COLUMNS — the canonical superset stored in ledger_rows.cells. It is
//   the union of both workbooks plus Row Key, so a single stored row can be
//   projected into either format by picking keys. Where the two files name the
//   same fact differently (Quality/Resolution, Ratio/Aspect Ratio,
//   Output Stored?/Storage State) the superset carries BOTH keys with the
//   value each file expects, rather than picking a winner and translating at
//   export time — projection stays a pick, never a transform.
//
// Row Key exists only in the canonical shape. The workbooks never had it, so
// the exports never show it; the SharePoint sync does need it, which is why it
// lives here and not in either workbook list.

export const ROW_KEY_COLUMN = 'Row Key';

// logline-generations-master.xlsx · "All Generations" · 41 columns.
export const MASTER_COLUMNS = [
    'Era',
    'Media',
    'Date (IST)',
    'Time (IST)',
    'User Name',
    'User Email',
    'Project',
    'Model',
    'Mode / Style',
    'Status',
    'PROMPT (exact)',
    'Enhanced Prompt (as sent)',
    'Ref Count',
    'REFERENCE ASSETS (role · name · key)',
    'Ref 1 Link',
    'Ref 2 Link',
    'Ref 3 Link',
    'Ref 4 Link',
    'Ref 5 Link',
    'Ref 6 Link',
    'OUTPUT LINK',
    'Output Key',
    'Output Stored?',
    'DOWNLOADED?',
    'Download Count',
    'Downloaded At (IST)',
    'Liked?',
    'Binned?',
    'Quality',
    'Ratio',
    'Duration (s)',
    'Session ID',
    'Try #',
    'Tries in Session',
    'Accepted Output',
    'Acceptance Basis',
    'Confidence',
    'Cost (USD)',
    'Generation ID',
    'Task ID',
    'Failure Reason',
];

// video-generations-all-time.xlsx · "Video Generations" · 45 columns.
export const VIDEO_COLUMNS = [
    'Era',
    'Generation ID',
    'Date (IST)',
    'Time (IST)',
    'User Name',
    'User Email',
    'Project',
    'Model',
    'Mode / Style',
    'Status',
    'PROMPT (exact)',
    'Enhanced Prompt (as sent)',
    '▶ OPEN VIDEO',
    'Storage Bucket',
    'Storage Key (object path)',
    'Full Storage URL',
    'Storage State',
    'Ref Count',
    'REFERENCE ASSETS (role · name · key)',
    'Ref 1 Link',
    'Ref 2 Link',
    'Ref 3 Link',
    'Ref 4 Link',
    'Ref 5 Link',
    'Ref 6 Link',
    'DOWNLOADED?',
    'Download Count',
    'Downloaded At (IST)',
    'Liked?',
    'Binned?',
    'Resolution',
    'Duration (s)',
    'Aspect Ratio',
    'Had Video Input',
    'Session ID',
    'Try #',
    'Tries in Session',
    'Successes in Session',
    'Accepted Output',
    'Acceptance Basis',
    'Confidence',
    'Cost (USD)',
    'Task ID',
    'Provider URL (expires ~24h)',
    'Failure Reason',
];

// The canonical superset: Row Key + everything either workbook needs.
export const LEDGER_COLUMNS = [
    ROW_KEY_COLUMN,
    ...MASTER_COLUMNS,
    ...VIDEO_COLUMNS.filter((c) => !MASTER_COLUMNS.includes(c)),
];

// Reference Assets sheets. The two files differ: the master carries a Media
// column (it holds both media) and renders the durable key as blank when there
// is none; the video file omits Media, links the filename, and spells the
// absence out as "(no durable key)".
export const MASTER_REF_COLUMNS = [
    'Task ID', 'Date (IST)', 'User', 'Media', 'Ref #', 'Role',
    'File Name', 'Durable Key', 'Link', 'Asset ID', 'Prompt (exact)',
];
export const VIDEO_REF_COLUMNS = [
    'Task ID', 'Date (IST)', 'User', 'Ref #', 'Role',
    'File Name', '▶ OPEN REF', 'Durable Key', 'Asset ID', 'PROMPT (exact)',
];

// The four roll-up sheets in the video workbook share one shape.
export const AGGREGATE_COLUMNS = [
    'Generations', 'Succeeded', 'Failed', 'Success Rate',
    'Downloaded', 'Archive Confirmed', 'Total Cost (USD)',
];

// Columns the sync owns end here. Anything a person adds to the RIGHT of the
// synced block is theirs and is never read, written or cleared — the writer
// only ever addresses columns 0..LEDGER_COLUMNS.length-1. Without this rule a
// one-way mirror silently eats every note anyone types into the workbook.
export const RESERVED_HUMAN_COLUMNS = ['Notes', 'Review Status', 'Tags'];

export const REF_LINK_SLOTS = 6;

// Storage State — the video workbook's exact three-valued wording. The
// distinction the master file's two-valued "Output Stored?" loses is between
// "the object may be missing" and "nothing was ever produced".
export const STORAGE_STATE = {
    CONFIRMED: 'Confirmed — archived by server',
    EXPECTED: 'Expected — key derived, archive unconfirmed',
    NOT_ARCHIVED: 'Not archived — never reached the provider',
};

// Output Stored? — the master workbook's wording. "In Postgres" is a real
// state, not a bug: seven Nano Banana images returned base64 inline and were
// never written to object storage, so they have no key and no link.
export const OUTPUT_STORED = {
    CONFIRMED: 'Confirmed',
    UNCONFIRMED: 'Unconfirmed',
    IN_POSTGRES: 'In Postgres',
};
export const NO_LINK_IN_POSTGRES = '(stored as base64 in Postgres — no link)';

export const OPEN_VIDEO_LABEL = 'Open video ▶';
export const PROVIDER_URL_EXPIRED = 'stored (expired)';
export const NO_DURABLE_KEY = '(no durable key)';
export const NOT_RECORDED = '(not recorded)';

// Rows are keyed on something that exists at INSERT and never changes.
// jobs.provider_task_id is NULL until the provider accepts, so a
// coalesce(provider_task_id, …) key MUTATES mid-lifecycle and would append a
// second row on the third write of every generation.
export function rowKeyForJob(jobId) {
    return `job:${jobId}`;
}

export function rowKeyForPreGateway(taskId) {
    return `pre:${taskId}`;
}

// A cells object → the positional array a sheet expects. Missing keys become
// '' rather than undefined: Graph rejects undefined in a values row, and a
// blank cell is what the workbooks actually show.
export function toValuesRow(cells, columns = LEDGER_COLUMNS) {
    return columns.map((name) => {
        const v = cells?.[name];
        return v === undefined || v === null ? '' : v;
    });
}

// Project a canonical row into one workbook's exact shape.
export function projectRow(cells, columns) {
    const out = {};
    for (const name of columns) {
        const v = cells?.[name];
        out[name] = v === undefined || v === null ? '' : v;
    }
    return out;
}
