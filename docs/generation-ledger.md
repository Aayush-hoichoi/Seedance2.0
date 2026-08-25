# The generation ledger

One row per generation — whatever its outcome — mirrored live into the two
SharePoint workbooks.

## What it replaces

Two hand-built exports, produced 90 minutes apart on 2026-08-21, that had
already disagreed by the time they were saved:

| | `logline-generations-master.xlsx` | `video-generations-all-time.xlsx` |
| --- | --- | --- |
| Rows | 9,133 (Video 7,614 + Image 1,519) | 7,639 (video only) |
| Columns | 41 | 45 |
| Keyed on | `Task ID` — 0 blank, 9,133 distinct | `Task ID` — **898 blank** |
| Downloads recorded | 350 | 354 |

They diverged because each one re-derived the data independently. The ledger
derives once, into `ledger_rows`, and mirrors that into both files — so the two
workbooks cannot drift apart from each other again.

## The workbooks are the specification

The exports do not approximate the two hand-built files — they reproduce them.

| | `logline-generations-master.xlsx` | `video-generations-all-time.xlsx` |
| --- | --- | --- |
| Sheets | 4 | 8 |
| Columns | 41 | 45 |
| Media | image + video | video only |
| Hyperlinks | none — URLs are plain text | 25,955 |
| Roll-ups | — | By User / Model / Project / Date |

`tests/ledgerWorkbookFidelity.test.mjs` asserts our column lists and value
vocabulary against those files directly: header order, the three Storage State
sentences, the three Output Stored? words, every Acceptance Basis string, the
Yes/No vs YES/no capitalisation split, and the fixed labels
(`Open video ▶`, `stored (expired)`, `(no durable key)`). It skips cleanly when
the files are absent, so it is the highest-value test here whenever they are
present.

The two files disagree on exactly one string — the master says
`No successful output`, the video file says `No successful output in this
session`. The canonical row carries the video wording and `masterWorkbook()`
rewrites it. `lib/ledger/columns.mjs` carries BOTH names wherever the files
disagree (Quality/Resolution, Ratio/Aspect Ratio, Output Stored?/Storage State)
so projecting into a workbook is a pick and never a transform — a rename at
export time is where two files start to drift apart.

## Acceptance, exactly as the workbooks compute it

| Condition | Acceptance Basis | Accepted | Confidence |
| --- | --- | --- | --- |
| this row was downloaded | `Downloaded by the user (recorded fact)` | YES | Recorded |
| session has a download, this row is not it | `Not downloaded — discarded` | | — |
| last success, and the only one | `Only successful try (derived)` | YES | High |
| last success of N | `Last successful try of N (derived)` | YES | Medium / Low |
| a success beaten by a later one | `Superseded (derived)` | | — |
| not a success, session produced nothing | `No successful output…` | | — |
| not a success, session produced something | `Failed` | | — |

Recovered by cross-tabulating the real column against status, download count,
success count and position-in-session over all 7,639 video rows.

## The four invariants

Everything correct about this design reduces to these.

1. **The key never changes.** `job:5231` at queue time, `job:5231` forever.
   `provider_task_id` arrives *after* the row exists (`markSubmitted`), so a
   `coalesce(provider_task_id, …)` key mutates mid-lifecycle and appends a
   second row on the third write of every generation.
2. **The unit of write is the session, not the row.** A new success rewrites
   its siblings' `Accepted Output` and `Confidence`. Per-row upserts leave two
   rows marked `YES` in one session.
3. **The watermark advances only after rows are committed.** Crash, lock or
   throttle → the same range is redone, and every write is an upsert, so
   redoing it is a no-op.
4. **The Excel write is out-of-band.** Graph down, file locked, secret expired
   → generations keep running. `sweep()` catches both halves.

## Flow

```
 Generate ─► jobs ─► generation_ledger ─► ledger_rows ─┬─► ledger_sync(master) ─► master.xlsx
            (7 statuses)     (view)      (staging)     └─► ledger_sync(video)  ─► video.xlsx
```

`sweep()` runs `runLedgerTick()` then `drainLedger()`, at most once a minute
across all instances via the existing `gateway_state` lock.

## Statuses covered

Every one. `queued` · `running` · `succeeded` · `failed` · `timed_out` ·
`cancelled` · `rejected`, plus the pre-gateway era as `(not recorded)`.

Neither pre-existing view could back this:

- `dataset_samples` filters `status = 'succeeded'`.
- `gallery_generations` filters `provider_task_id IS NOT NULL` — and 1,112 of
  the historical failures have no provider task id, because they failed before
  the provider ever accepted them.

`rejected` is new. Eight paths in `enqueue.mjs` used to return before
`insertJob`, so a generation the gateway turned away left no trace at all —
indistinguishable from never pressing the button. Each now writes a terminal
`rejected` job row first. `processQueue` only ever claims `queued`, so a
rejected row is never run.

## Files

| Path | Role |
| --- | --- |
| `lib/ledger/columns.mjs` | the 47-column contract — one definition |
| `lib/ledger/sessions.mjs` | session segmentation + acceptance (pure) |
| `lib/ledger/shape.mjs` | ledger row → 47 cells (pure) |
| `lib/ledger/sync.mjs` | the tick: view → `ledger_rows` → dirty |
| `lib/ledger/filters.mjs` | the console's model / user / project filters, and the values its dropdowns offer |
| `lib/ledger/exportRows.mjs` | which rows an export holds — sessions over all history, *then* the filter |
| `lib/ledger/writer.mjs` | drains dirty rows into the workbooks |
| `lib/ledger/targets.mjs` | which workbooks, and what each takes |
| `lib/graph/workbook.mjs` | Graph Excel client (session, add, patch, 423/429) |
| `lib/ledger/xlsxRead.mjs` | dependency-free .xlsx reader, for verification |

## Setup

### 1. Move the workbooks to a SharePoint document library

They currently live in a personal OneDrive, under `Microsoft Teams Chat Files`.
App-only access there needs `Files.ReadWrite.All` — write access to **every**
OneDrive in the tenant — and the files are deleted when the account is.

Move both to a team site library, e.g. `LoglineAI Studio → Documents → Ledger/`.

### 2. Prepare each workbook

- Add a **`Row Key`** column as column A.
- Select the header + data range → **Format as Table** → name it **`Ledger`**.
  Graph's row API addresses a table, not a range.
- Leave `Notes`, `Review Status` and `Tags` to the right of column AU. The
  writer only ever addresses columns 1–47 and never touches them.

### 3. Entra permissions

On the **existing** app registration (`TEAMS_APP_ID` — the ledger reuses the
Teams bot's credentials):

1. Microsoft Graph → **Application** → **`Sites.Selected`** → grant admin consent.
2. An admin assigns the app to the one site:
   ```
   POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
   { "roles": ["write"],
     "grantedToIdentities": [{ "application": { "id": "<TEAMS_APP_ID>" } }] }
   ```

`Sites.Selected` is what makes this approvable: it is one site, not the tenant.

### 4. Environment

```
node --env-file=.env.local scripts/graph-locate-workbook.mjs \
     hoichoitech.sharepoint.com /sites/LoglineAI "Ledger/logline-generations-master.xlsx"
```

Prints the `driveId` / `itemId` pair. Repeat for the video workbook, then set:

```
LEDGER_MASTER_DRIVE_ID=…
LEDGER_MASTER_ITEM_ID=…
LEDGER_VIDEO_DRIVE_ID=…
LEDGER_VIDEO_ITEM_ID=…
LEDGER_TABLE_NAME=Ledger        # optional, defaults to Ledger
```

With no target configured the writer no-ops and the ledger still fills
`ledger_rows` — so the database side can go live before SharePoint is ready.

### 5. Backfill and verify

```
node --env-file=.env.local scripts/ledger-backfill.mjs --dry-run
node --env-file=.env.local scripts/ledger-backfill.mjs --no-mark-dirty
node --env-file=.env.local scripts/ledger-verify.mjs \
     ~/Desktop/gen/logline-generations-master.xlsx "All Generations"
```

`--no-mark-dirty` seeds the database without queueing ~9,000 rows through
Graph one at a time (hours of sequential requests, for history the workbooks
already hold).

**Run the verifier the same day.** The frozen workbook is a known-good 9,133-row
answer produced by a completely independent query — the only real test
`generation_ledger` will ever get — and every new generation widens the gap
between it and the live database.

## Filtering the console

Free text (`?q=`) matches anywhere in a row. The three dropdowns —
**model**, **user**, **project** — are exact matches on one column each, and
combine with AND, with each other and with the search box.

Their options come from `/api/admin/ledger/facets`, which reads the distinct
values out of `ledger_rows` itself rather than from the `models` / `users` /
`projects` tables. That matters both ways round: the catalogue would offer
models nobody has ever run, and it would have lost the ones renamed or deleted
since the generations that used them. Building the list from the rows means
every option returns at least one row, and history keeps the name it was
generated under.

**Timeline order** is a fourth dropdown: `?sort=newest` (the default) or
`?sort=oldest`. The value is resolved through `LEDGER_SORTS` in
`lib/ledger/filters.mjs` and anything unrecognised falls back to the default,
so the ORDER BY fragment can only ever come from that map and never from the
request. Both orderings carry the `row_key` tiebreaker in the *same* direction
as the timestamp — submitted_at ties during a retry burst, and an unstable
tiebreaker would let a row appear on two pages, or on none, while paging.

The export stays chronological regardless of this setting: the workbooks are
defined as a history, and re-ordering them would break the thing the export
exists to reproduce.

Two details worth knowing:

- **The user filter matches `User Email`, not `User Name`.** Two people can
  share a display name; nobody shares an address. The dropdown still shows the
  name.
- **`(not recorded)` is a real option**, not a gap. It is how the 1,715
  pre-gateway rows — which carry no user, model or project — are selected.

Facets are scoped by workbook and media, so the video view never offers an
image-only model. They are deliberately *not* cascaded by each other: a chosen
model narrowing the user list could strand a selection the admin can no longer
see to clear.

### Downloading the current view

`/api/admin/ledger/export` takes the same `q` / `model` / `user` / `project` /
`media` parameters as the list, so the file holds exactly the rows on screen.
The console shows a **This view (N)** button whenever the view is narrowed,
alongside the two full-workbook buttons — which still export everything, since
reproducing the whole workbook is the property the ledger exists to protect.

Three things make a filtered export safe to hand to someone:

- **Sessions are computed over the whole history, then rows are dropped.**
  `lib/ledger/exportRows.mjs` exists to hold that order. Filtering first would
  recompute `Try #`, `Tries in Session`, `Successes in Session` and
  `Accepted Output` against only the surviving rows — so filtering to one model
  would renumber its tries as though the other models had never run, and could
  promote a `Superseded` row to the session's accepted output. A filtered
  export narrows which rows you see; it must never change what a row says.
  `tests/ledgerExportRows.test.mjs` fails if the order is swapped.
- **The roll-up sheets are rebuilt from the selection**, so a filtered file
  totals the view it contains rather than a history it does not.
- **The filename changes** to `…-view.xlsx`, and the audit row records the
  filters. A partial view must not reach someone's Downloads folder under the
  name of the real workbook.

## Operating

**"The workbook is open in Excel."** Graph returns `423 resourceLocked` and
exposes no way to check the lock beforehand. The writer stops cleanly, rows
stay `dirty`, and the backlog drains in order when the file closes. Nothing is
lost and nothing duplicates. Expect this line:

```
[ledger] master (logline-generations-master.xlsx) is open in Excel — 12 row(s) queued
```

Each target locks independently, so a locked video workbook never stalls the
master.

**Why writes are sequential.** Microsoft is explicit that concurrent writes to
one workbook cause throttling, timeouts and merge conflicts rather than
throughput. At ~180 generations/day there is nothing to gain from parallelism.
Graph allows 1,500 requests per 10s per app per tenant; the ledger needs ~1 per
minute.

**Row indexes.** Stored indexes are a hint, not a fact — a human inserting a
row in Excel shifts everything below it. The writer re-reads the key column
once per drain and trusts that over the stored index.

**Size.** Excel Online's supported ceiling is ~25 MB; the files are ~4.5 MB and
grow ~65k rows/year. The Reference Assets tab (16,586 rows) grows about twice
as fast as the generation tab and will need capping or splitting first.

## Known data gaps

Properties of the generation pipeline, not of the sync. A live sheet inherits
every one of them, and looks more authoritative while doing so.

- **Image downloads are not tracked.** `generation_events` has no rows for
  image task ids. All 1,519 image rows read `DOWNLOADED? = no`, which means
  *not tracked*, not *not downloaded*.
- **Image reference assets are not stored.** They are base64 inside
  `jobs.request_body.parts`, never written to object storage, so no durable key
  or link exists — although `Ref Count` is correct.
- **24% of video reference assets have no durable key.** Registered only into
  the BytePlus Asset Library, which sweeps its objects after about an hour.
- **`OUTPUT LINK` depends on `ARK_AK`/`ARK_SK`.** Both hand-built exports fell
  back to the archive proxy because the key in `.env.local` was rejected by TOS
  (`InvalidAccessKeyId`). With working keys the column becomes a direct link.
