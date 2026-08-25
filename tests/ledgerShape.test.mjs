import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LEDGER_COLUMNS, MASTER_COLUMNS, VIDEO_COLUMNS, ROW_KEY_COLUMN,
    RESERVED_HUMAN_COLUMNS, toValuesRow, projectRow,
    rowKeyForJob, rowKeyForPreGateway, STORAGE_STATE, OUTPUT_STORED,
} from '../lib/ledger/columns.mjs';
import { shapeLedgerRow } from '../lib/ledger/shape.mjs';

function ledgerRow(over = {}) {
    return {
        row_key: 'job:3644',
        era: 'Gateway',
        media: 'Video',
        submitted_at: new Date('2026-07-24T10:10:21Z'), // 15:40:21 IST
        user_id: 'u1',
        user_name: 'Shinjini Nandy',
        user_email: 'shinjini.nandy@hoichoi.tv',
        project_name: 'Hooliganism',
        model_id: 'seedance-2.0',
        provider_id: 'byteplus',
        status: 'succeeded',
        generation_id: 3644,
        task_id: 'cgt-20260724181022-9tfr5',
        resolution: '1080p',
        duration: 10,
        ratio: '16:9',
        has_video_input: false,
        user_prompt: 'One single continuous forward zoom-in',
        generated_prompt: '',
        style: 'reference',
        input_refs: [],
        binned: false,
        output_key: 'videos/cgt-20260724181022-9tfr5.mp4',
        output_confirmed: true,
        error_message: null,
        est_cost_usd: 3.76,
        cost_usd: 3.7578,
        downloads: 1,
        likes: 0,
        last_downloaded_at: new Date('2026-07-26T07:51:51Z'),
        session_id: 'S-003644',
        try_number: 1,
        tries_in_session: 2,
        successes_in_session: 2,
        accepted_output: 'YES',
        acceptance_basis: 'Downloaded by the user (recorded fact)',
        confidence: 'Recorded',
        ...over,
    };
}

test('the two workbook shapes are 41 and 45 columns', () => {
    assert.equal(MASTER_COLUMNS.length, 41);
    assert.equal(VIDEO_COLUMNS.length, 45);
    assert.equal(new Set(MASTER_COLUMNS).size, 41);
    assert.equal(new Set(VIDEO_COLUMNS).size, 45);
});

test('the canonical superset covers both workbooks plus the row key', () => {
    assert.equal(LEDGER_COLUMNS[0], ROW_KEY_COLUMN);
    assert.equal(new Set(LEDGER_COLUMNS).size, LEDGER_COLUMNS.length, 'no duplicates');
    for (const c of [...MASTER_COLUMNS, ...VIDEO_COLUMNS]) {
        assert.ok(LEDGER_COLUMNS.includes(c), `superset is missing ${c}`);
    }
});

test('Row Key is canonical only — neither workbook ever had it', () => {
    assert.ok(!MASTER_COLUMNS.includes(ROW_KEY_COLUMN));
    assert.ok(!VIDEO_COLUMNS.includes(ROW_KEY_COLUMN));
});

test('both spellings are carried, so projection is a pick and never a transform', () => {
    // The two files name the same facts differently. Reconciling to one name
    // would force a rename at export time, and a rename is where drift starts.
    for (const pair of [['Quality', 'Resolution'], ['Ratio', 'Aspect Ratio'], ['Output Stored?', 'Storage State']]) {
        for (const name of pair) assert.ok(LEDGER_COLUMNS.includes(name), `superset is missing ${name}`);
    }
    assert.ok(MASTER_COLUMNS.includes('Quality') && !MASTER_COLUMNS.includes('Resolution'));
    assert.ok(VIDEO_COLUMNS.includes('Resolution') && !VIDEO_COLUMNS.includes('Quality'));
});

test('human columns are not part of the synced block', () => {
    for (const name of RESERVED_HUMAN_COLUMNS) {
        assert.ok(!LEDGER_COLUMNS.includes(name), `${name} must never be written by the sync`);
    }
});

test('row keys are invariant and disambiguated by era', () => {
    assert.equal(rowKeyForJob(3644), 'job:3644');
    assert.equal(rowKeyForPreGateway('cgt-x'), 'pre:cgt-x');
});

test('shape fills every declared column, never undefined', () => {
    const cells = shapeLedgerRow(ledgerRow());
    for (const name of LEDGER_COLUMNS) {
        assert.ok(name in cells, `missing column ${name}`);
        assert.notEqual(cells[name], undefined);
    }
});

test('projecting into either workbook yields exactly its columns', () => {
    const cells = shapeLedgerRow(ledgerRow());
    assert.deepEqual(Object.keys(projectRow(cells, MASTER_COLUMNS)), MASTER_COLUMNS);
    assert.deepEqual(Object.keys(projectRow(cells, VIDEO_COLUMNS)), VIDEO_COLUMNS);
});

test('timestamps render in IST', () => {
    const cells = shapeLedgerRow(ledgerRow());
    assert.equal(cells['Date (IST)'], '2026-07-24');
    assert.equal(cells['Time (IST)'], '15:40:21');
    assert.equal(cells['Downloaded At (IST)'], '2026-07-26 13:21:51');
});

test('the same fact appears under both workbooks’ headings', () => {
    const cells = shapeLedgerRow(ledgerRow());
    assert.equal(cells.Quality, '1080p');
    assert.equal(cells.Resolution, '1080p');
    assert.equal(cells.Ratio, '16:9');
    assert.equal(cells['Aspect Ratio'], '16:9');
});

test('storage is described in each workbook’s own words', () => {
    const cells = shapeLedgerRow(ledgerRow());
    assert.equal(cells['Storage State'], STORAGE_STATE.CONFIRMED);
    assert.equal(cells['Storage State'], 'Confirmed — archived by server');
    assert.equal(cells['Output Stored?'], OUTPUT_STORED.CONFIRMED);
    assert.equal(cells['▶ OPEN VIDEO'], 'Open video ▶');
    assert.equal(cells['Storage Key (object path)'], 'videos/cgt-20260724181022-9tfr5.mp4');
    assert.match(cells['Full Storage URL'], /^https:\/\/.+\.bytepluses\.com\/videos\//);
});

test('a queued generation renders a full row with the output columns empty', () => {
    const cells = shapeLedgerRow(ledgerRow({
        status: 'queued', task_id: null, output_key: null, output_confirmed: false,
        cost_usd: null, downloads: 0, last_downloaded_at: null,
        accepted_output: '', acceptance_basis: '', confidence: '—',
    }));
    assert.equal(cells.Status, 'queued');
    assert.equal(cells['Task ID'], '');
    assert.equal(cells['Storage Key (object path)'], '');
    assert.equal(cells['▶ OPEN VIDEO'], '');
    assert.equal(cells['Cost (USD)'], 3.76, 'falls back to the estimate until settlement');
    assert.equal(cells['Row Key'], 'job:3644', 'the key exists from the first instant');
});

test('a failure that never reached the provider is Not archived, not Expected', () => {
    const cells = shapeLedgerRow(ledgerRow({
        status: 'failed', task_id: null, output_key: null, output_confirmed: false,
        cost_usd: null, est_cost_usd: null,
        error_message: "Image was blocked by the model's safety filter",
    }));
    assert.equal(cells['Storage State'], 'Not archived — never reached the provider');
    assert.equal(cells['Output Stored?'], OUTPUT_STORED.UNCONFIRMED);
    assert.equal(cells['Failure Reason'], "Image was blocked by the model's safety filter");
    assert.equal(cells['Cost (USD)'], 0, 'a failure releases its reservation — it cost nothing');
});

test('cost is the settlement, zero on failure, the estimate only in flight', () => {
    // Falling back to the estimate on a failure would overstate the cost of
    // 1,307 historical rows and inflate every roll-up that sums the column.
    assert.equal(shapeLedgerRow(ledgerRow())['Cost (USD)'], 3.7578, 'settled');
    for (const status of ['failed', 'timed_out', 'cancelled', 'rejected']) {
        assert.equal(
            shapeLedgerRow(ledgerRow({ status, cost_usd: null }))['Cost (USD)'], 0,
            `${status} must cost nothing`,
        );
    }
    assert.equal(shapeLedgerRow(ledgerRow({ status: 'queued', cost_usd: null }))['Cost (USD)'], 3.76,
        'in flight, the estimate is the best number there is');
    assert.equal(
        shapeLedgerRow(ledgerRow({ era: 'Pre-gateway', status: null, cost_usd: null, est_cost_usd: null }))['Cost (USD)'],
        '', 'pre-gateway never recorded cost at all',
    );
});

test('an unwritten key is Expected, not Confirmed', () => {
    const cells = shapeLedgerRow(ledgerRow({ output_confirmed: false }));
    assert.equal(cells['Storage State'], 'Expected — key derived, archive unconfirmed');
});

test('an image returned inline is "In Postgres", with no link to offer', () => {
    // Seven Nano Banana images did exactly this: succeeded, no storage key.
    const cells = shapeLedgerRow(ledgerRow({
        media: 'Image', status: 'succeeded', output_key: null, output_confirmed: false,
    }));
    assert.equal(cells['Output Stored?'], 'In Postgres');
    assert.equal(cells['OUTPUT LINK'], '(stored as base64 in Postgres — no link)');
});

test('a rejected generation is a first-class row', () => {
    const cells = shapeLedgerRow(ledgerRow({
        status: 'rejected', task_id: null, output_key: null, output_confirmed: false,
        cost_usd: null, est_cost_usd: null,
        error_message: 'A budget or quota limit would be exceeded.',
    }));
    assert.equal(cells.Status, 'rejected');
    assert.equal(cells['Failure Reason'], 'A budget or quota limit would be exceeded.');
});

test('reference assets are summarised the way the workbooks write them', () => {
    const cells = shapeLedgerRow(ledgerRow({
        input_refs: [
            { role: 'reference image', name: '1.png', tosKey: 'uploads/abc-1.png' },
            { role: 'reference image', name: '2.png' },
        ],
    }));
    assert.equal(cells['Ref Count'], 2);
    assert.match(cells['REFERENCE ASSETS (role · name · key)'], /1\. \[reference image\] 1\.png → uploads\/abc-1\.png/);
    assert.match(cells['REFERENCE ASSETS (role · name · key)'], /2\. \[reference image\] 2\.png → \(no durable key\)/);
    assert.equal(cells['Ref 3 Link'], '', 'unused slots stay blank');
});

test('pre-gateway rows say "(not recorded)" rather than pretending to be blank', () => {
    const cells = shapeLedgerRow(ledgerRow({
        era: 'Pre-gateway', user_id: null, user_name: null, user_email: null,
        project_name: null, model_id: null, status: null, generation_id: null,
        est_cost_usd: null, cost_usd: null,
        session_id: '—', try_number: '', tries_in_session: '', successes_in_session: '',
        accepted_output: '', acceptance_basis: '', confidence: '',
    }));
    assert.equal(cells['User Email'], '(not recorded)');
    assert.equal(cells.Model, '(not recorded)');
    assert.equal(cells.Status, '(not recorded)');
    assert.equal(cells['Had Video Input'], '', 'pre-gateway never recorded settings');
});

test('Had Video Input capitalises differently from the yes/no columns', () => {
    // The workbook does it this way; matching it is the point.
    assert.equal(shapeLedgerRow(ledgerRow({ has_video_input: true }))['Had Video Input'], 'Yes');
    assert.equal(shapeLedgerRow(ledgerRow({ has_video_input: false }))['Had Video Input'], 'No');
    assert.equal(shapeLedgerRow(ledgerRow())['DOWNLOADED?'], 'YES', 'but downloads are YES/no');
    assert.equal(shapeLedgerRow(ledgerRow({ media: 'Image' }))['Had Video Input'], '', 'blank for images');
});

test('toValuesRow is positional against whichever shape it is given', () => {
    const cells = shapeLedgerRow(ledgerRow());
    assert.equal(toValuesRow(cells, MASTER_COLUMNS).length, 41);
    assert.equal(toValuesRow(cells, VIDEO_COLUMNS).length, 45);
    assert.equal(toValuesRow(cells)[0], 'job:3644');
    assert.ok(toValuesRow(cells, VIDEO_COLUMNS).every((v) => v !== undefined && v !== null));
});
