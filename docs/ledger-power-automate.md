# The no-admin route: Power Automate

The server-side Graph writer needs `Sites.Selected` and an admin's consent.
This route needs neither. A Power Automate flow signs in **as you**, using
connectors Microsoft already trusts across the tenant, and writes the same rows
into the same workbooks.

Both routes drain the same `ledger_sync` queue, so you can run either — or both
during a switch-over — without anything diverging.

| | Graph writer | Power Automate |
| --- | --- | --- |
| Entra app registration | required | **none** |
| `Sites.Selected` + admin consent | required | **none** |
| Files must move off personal OneDrive | yes | **no** |
| Logic lives in | git | a GUI |
| Excel file-lock (423) | applies | applies |
| Setup time | days (waiting on admin) | **an hour** |

The file lock applies either way — that is Excel, not permissions.

## What the app provides

Two endpoints, both authenticated by `Authorization: Bearer <CRON_SECRET>`.
They sit outside the Clerk gate (a flow cannot carry a Clerk session), so the
bearer check is the only gate and it **fails closed**: with `CRON_SECRET` unset
every request is refused.

### `GET /api/ledger/pending?target=master&limit=100`

```json
{
  "target": "master",
  "workbook": "logline-generations-master.xlsx",
  "count": 3,
  "remaining": 0,
  "columns": ["Row Key", "Era", "Media", "..."],
  "rows": [
    { "Row Key": "job:5231", "Era": "Gateway", "Media": "Video",
      "Status": "queued", "...": "...", "_rowKey": "job:5231" }
  ]
}
```

Rows are keyed by the workbook's own column names, so the Excel connector's
field mapping is one-to-one and the flow needs no transform step. `remaining`
is what is still queued *after* this batch, so a flow can loop until zero
instead of guessing whether one pass was enough.

`target` is `master` or `video`. The video workbook is served only its own
rows — the filtering happens server-side, so the flow cannot get it wrong.

### `POST /api/ledger/ack`

```json
{ "target": "master", "rowKeys": ["job:5231", "job:5232"] }
```

Accepts `rowKey` (single) or `rowKeys` (array). Acknowledge **the rows you
actually wrote**, not everything you were served: a flow that dies half way
leaves the rest dirty and they come back on the next poll. That is what makes
the sheet converge instead of quietly losing rows.

## Setting up the flow

Do this once per workbook.

### 1. Prepare the workbook

Wherever it is now — personal OneDrive is fine for this route:

- Add a **`Row Key`** column as column A.
- Select the header + data → **Format as Table** → name it **`Ledger`**.
- Keep any personal notes in columns to the right of the last synced column.

### 2. Create a scheduled flow

**Power Automate → Create → Scheduled cloud flow**, every **5 minutes**.

### 3. HTTP — get the pending rows

| Field | Value |
| --- | --- |
| Method | `GET` |
| URI | `https://<your-app>/api/ledger/pending?target=master&limit=50` |
| Headers | `Authorization: Bearer <CRON_SECRET>` |

> The **HTTP** action is a premium connector. If your licence does not include
> it, use **HTTP with Microsoft Entra ID**, or move this call into an Azure
> Function. Check this before building the rest — it is the one licensing
> question on this route.

### 4. Parse JSON

Action: **Parse JSON**. Content: the HTTP `body`. For the schema, run the flow
once and use **Generate from sample** with the real response — the column set
is fixed, so the generated schema stays valid.

### 5. Apply to each row

Inside the loop, on `body/rows`:

**Excel Online (Business) → Update a row**

| Field | Value |
| --- | --- |
| Location / Library | your OneDrive or site |
| File | the workbook |
| Table | `Ledger` |
| Key Column | `Row Key` |
| Key Value | `_rowKey` from the current item |
| Row | map each column to the matching field |

Then set **Configure run after** on a following **Add a row into a table**
action so it runs only when *Update a row* **has failed** — that covers rows
that do not exist yet. Same table, same field mapping.

### 6. Acknowledge

Still inside the loop, after the write succeeds:

| Field | Value |
| --- | --- |
| Method | `POST` |
| URI | `https://<your-app>/api/ledger/ack` |
| Headers | `Authorization: Bearer <CRON_SECRET>`, `Content-Type: application/json` |
| Body | `{ "target": "master", "rowKey": "<_rowKey>" }` |

Acknowledging per row rather than per batch is slower but exactly correct: only
rows that really landed are marked done. At ~7 generations an hour the
difference is irrelevant.

### 7. Repeat for the video workbook

Copy the flow, change `target=master` to `target=video`, point it at the other
file. Keep them as **separate flows** so a lock on one cannot stall the other.

## Limits to respect

- **Excel Online connector**: concurrent writes to one workbook are
  unsupported. Leave the loop's concurrency at its default of 1.
- **Pagination**: list actions return 256 rows by default. The `limit`
  parameter keeps batches well under that.
- **Office Scripts** (if you use them): 1,600 runs/day, 3 calls per 10 seconds,
  120-second timeout.
- **423 Locked**: while someone has the workbook open the write fails. Leave
  those rows unacknowledged and they retry automatically.

At ~180 generations/day none of these bite. They matter only if volume grows by
an order of magnitude.

## Moving to the Graph writer later

When the admin request comes through:

1. Set the four `LEDGER_*_DRIVE_ID` / `LEDGER_*_ITEM_ID` variables.
2. Turn the flows off.

Nothing else changes. The queue, the keys and the row shapes are identical, so
the Graph writer picks up exactly where the flows stopped — including anything
they left unacknowledged.
