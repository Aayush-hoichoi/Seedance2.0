'use client';

// The generation ledger, shown in the exact shape of the two workbooks.
//
// The table on screen and the file you download are the same columns, in the
// same order, with the same wording — 41 for the master workbook, 45 for the
// video one. Anything else and "export" becomes a second thing to reconcile,
// which is the problem this replaced.

import { useState } from 'react';
import { Images, Video, Download, Layers, FileSpreadsheet } from 'lucide-react';
import { useApi, fmtInt } from '../lib.js';
import { PageHeader, Card, Button, Input, Select, Badge, EmptyState } from '../ui.jsx';

const WORKBOOKS = {
    master: {
        id: 'master',
        label: 'All generations',
        file: 'logline-generations-master.xlsx',
        hint: '41 columns · images and video · 4 sheets',
        media: true,
    },
    video: {
        id: 'video',
        label: 'Videos (all-time)',
        file: 'video-generations-all-time.xlsx',
        hint: '45 columns · video only · 8 sheets',
        media: false,
    },
};

const MEDIA_TABS = [
    { id: 'all', label: 'Everything', icon: Layers },
    { id: 'Video', label: 'Generated videos', icon: Video },
    { id: 'Image', label: 'Generated images', icon: Images },
];

// Columns that lead in the browser. The rest follow in workbook order and are
// reachable by scrolling sideways — no column is hidden, because "the exact
// table" means the exact table.
const LEAD = [
    'Date (IST)', 'Time (IST)', 'User Name', 'Project', 'Model', 'Status',
    'PROMPT (exact)', 'Accepted Output', 'Cost (USD)', 'Task ID',
];

const STATUS_TONE = {
    succeeded: 'green',
    failed: 'red',
    timed_out: 'red',
    rejected: 'amber',
    cancelled: 'zinc',
    queued: 'blue',
    running: 'blue',
};

const PAGE_SIZE = 100;

// The ledger is a live record, so the page has to behave like one.
//
// useApi defaults to revalidateOnFocus:false and no interval, which suits a
// settings screen and badly misleads here: a tab left open on the ledger kept
// showing whatever was true when it was opened, so a generation that ran in
// the meantime looked like a generation the ledger had missed. Both are on
// here, and keepPreviousData means a refresh swaps the rows without blanking
// the table under the reader.
//
// SWR pauses polling while the tab is hidden, so an open-but-unwatched console
// costs nothing.
const POLL_MS = 20_000;
const FACET_POLL_MS = 120_000;

// The three dropdown filters, in the order they read as a sentence: which
// model, run by whom, for which project. `key` is both the query parameter and
// the field of the facets response — one name end to end.
const FILTERS = [
    { key: 'model', all: 'All models' },
    { key: 'user', all: 'All users' },
    { key: 'project', all: 'All projects' },
];

// Timeline order. Mirrors LEDGER_SORTS in lib/ledger/filters.mjs — the server
// resolves the key through its own map and ignores anything it does not know,
// so a stale option here degrades to the default rather than erroring.
const SORTS = [
    { key: 'newest', label: 'Newest first' },
    { key: 'oldest', label: 'Oldest first' },
];

function orderColumns(columns) {
    if (!columns?.length) return [];
    const lead = LEAD.filter((c) => columns.includes(c));
    return [...lead, ...columns.filter((c) => !lead.includes(c))];
}

function Cell({ column, value }) {
    if (value === '' || value === null || value === undefined) {
        return <span className="text-ink-3">—</span>;
    }
    if (column === 'Status') return <Badge tone={STATUS_TONE[value] ?? 'zinc'}>{value}</Badge>;
    if (column === 'Accepted Output' && value === 'YES') return <Badge tone="green">YES</Badge>;
    if (column === 'DOWNLOADED?' && value === 'YES') return <Badge tone="blue">YES</Badge>;

    const text = String(value);
    const short = text.length > 55 ? `${text.slice(0, 55)}…` : text;

    // Any cell holding a URL is clickable — OUTPUT LINK, the six Ref links and
    // Full Storage URL all carry a bare http(s) string, so one rule here beats
    // a per-column list that goes stale the next time a column is added.
    if (/^https?:\/\//.test(text)) {
        return (
            <a
                href={text}
                target="_blank"
                rel="noopener noreferrer"
                title={text}
                className="text-accent-hi underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >
                {short}
            </a>
        );
    }

    if (text.length > 55) return <span title={text}>{short}</span>;
    return <span>{text}</span>;
}

export default function LedgerClient() {
    const [workbook, setWorkbook] = useState('master');
    const [media, setMedia] = useState('all');
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState('');
    const [picked, setPicked] = useState({ model: '', user: '', project: '' });
    const [sort, setSort] = useState('newest');
    const [page, setPage] = useState(0);

    const spec = WORKBOOKS[workbook];
    const scoped = spec.media && media !== 'all' ? media : null;

    const params = new URLSearchParams({
        workbook,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
    });
    if (scoped) params.set('media', scoped);
    if (search) params.set('q', search);
    for (const { key } of FILTERS) if (picked[key]) params.set(key, picked[key]);
    if (sort !== 'newest') params.set('sort', sort);

    // The dropdown values follow the workbook and media scope, so the video
    // view never offers an image-only model — but not the other filters, which
    // would let one choice empty another list and strand a selection.
    const facetParams = new URLSearchParams({ workbook });
    if (scoped) facetParams.set('media', scoped);
    const { data: facets } = useApi(`/api/admin/ledger/facets?${facetParams}`, {
        keepPreviousData: true,
        // A new model or project appears the first time someone uses one, which
        // is rare enough not to poll at the table's rate.
        refreshInterval: FACET_POLL_MS,
        revalidateOnFocus: true,
    });

    const { data, isLoading, error } = useApi(`/api/admin/ledger?${params}`, {
        keepPreviousData: true,
        refreshInterval: POLL_MS,
        revalidateOnFocus: true,
    });
    const columns = orderColumns(data?.columns);
    const rows = data?.rows ?? [];
    const total = data?.counts?.total ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const active = FILTERS.filter(({ key }) => picked[key]).length + (search ? 1 : 0);

    function pick(id) {
        setWorkbook(id);
        setMedia('all');
        setPage(0);
    }

    function choose(key, value) {
        setPicked((p) => ({ ...p, [key]: value }));
        setPage(0);
    }

    function reorder(value) {
        setSort(value);
        setPage(0);
    }

    function clearAll() {
        setPicked({ model: '', user: '', project: '' });
        setQuery('');
        setSearch('');
        setPage(0);
    }

    // The export takes the same parameters as the list, minus the paging: the
    // file is the whole view, not the page you happen to be looking at.
    const viewParams = new URLSearchParams({ workbook });
    if (scoped) viewParams.set('media', scoped);
    if (search) viewParams.set('q', search);
    for (const { key } of FILTERS) if (picked[key]) viewParams.set(key, picked[key]);
    const narrowed = active > 0 || Boolean(scoped);

    return (
        <div className="space-y-5">
            <PageHeader
                title="Generation ledger"
                subtitle="Every image and video generation — queued, running, succeeded, failed, timed out, cancelled or rejected."
            >
                {/* Plain navigation, not fetch(): the browser's own download
                    handling streams the file to disk and shows native progress,
                    which a blob round-trip through memory would not. */}
                <div className="flex flex-wrap gap-2">
                    {/* Only when the view is actually narrowed, and labelled
                        with what it holds — an unqualified "export" next to two
                        workbook buttons is how a filtered file gets passed on
                        as the whole ledger. */}
                    {narrowed ? (
                        <Button
                            variant="primary"
                            title={`Download the ${fmtInt(total)} row${total === 1 ? '' : 's'} currently shown`}
                            onClick={() => { window.location.href = `/api/admin/ledger/export?${viewParams}`; }}
                        >
                            <Download size={14} /> This view ({fmtInt(total)})
                        </Button>
                    ) : null}
                    <Button variant="outline" onClick={() => { window.location.href = '/api/admin/ledger/export?workbook=master'; }}>
                        <Download size={14} /> master.xlsx
                    </Button>
                    <Button variant={narrowed ? 'outline' : 'primary'} onClick={() => { window.location.href = '/api/admin/ledger/export?workbook=video'; }}>
                        <Download size={14} /> video.xlsx
                    </Button>
                </div>
            </PageHeader>

            <div className="flex flex-wrap items-center gap-2">
                {Object.values(WORKBOOKS).map((w) => (
                    <button
                        key={w.id}
                        onClick={() => pick(w.id)}
                        className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                            workbook === w.id
                                ? 'border-accent/40 bg-paper-2'
                                : 'border-line hover:bg-paper-2'
                        }`}
                    >
                        <FileSpreadsheet size={15} className={workbook === w.id ? 'mt-0.5 text-accent-hi' : 'mt-0.5 text-ink-3'} />
                        <span>
                            <span className="block text-sm font-medium text-ink">{w.label}</span>
                            <span className="block font-mono text-[11px] text-ink-3">{w.file}</span>
                            <span className="block text-[11px] text-ink-3">{w.hint}</span>
                        </span>
                    </button>
                ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
                {spec.media ? (
                    <div className="flex gap-1 rounded-lg border border-line bg-paper-1 p-1">
                        {MEDIA_TABS.map(({ id, label, icon: Icon }) => {
                            const count = id === 'Image' ? data?.counts?.images
                                : id === 'Video' ? data?.counts?.videos
                                    : null;
                            return (
                                <button
                                    key={id}
                                    onClick={() => { setMedia(id); setPage(0); }}
                                    className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${
                                        media === id ? 'bg-paper-3 font-medium text-ink' : 'text-ink-3 hover:text-ink-2'
                                    }`}
                                >
                                    <Icon size={14} />
                                    {label}
                                    {count != null ? <span className="text-xs text-ink-3">{fmtInt(count)}</span> : null}
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="text-xs text-ink-3">
                        Video only — this workbook has never held images.
                    </div>
                )}

                <form
                    onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); setPage(0); }}
                    className="flex gap-2"
                >
                    <Input
                        className="w-64"
                        placeholder="Search prompts, users, models…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    <Button variant="outline" type="submit">Search</Button>
                    {search ? (
                        <Button variant="ghost" type="button" onClick={() => { setQuery(''); setSearch(''); setPage(0); }}>
                            Clear
                        </Button>
                    ) : null}
                </form>
            </div>

            {/* Exact-match filters, from the values the rows actually carry.
                Free text above finds a phrase anywhere; these narrow to one
                model, one person or one project without guessing at spelling. */}
            <div className="flex flex-wrap items-center gap-2">
                {FILTERS.map(({ key, all }) => {
                    const options = facets?.[`${key}s`] ?? [];
                    const chosen = picked[key];
                    // A selection the current scope no longer offers — an
                    // image-only model after switching to the video workbook —
                    // has to stay in the list. Dropping it would filter the
                    // table by something invisible and unclearable.
                    const list = chosen && !options.some((o) => o.value === chosen)
                        ? [{ value: chosen, label: chosen, count: 0 }, ...options]
                        : options;
                    return (
                        <Select
                            key={key}
                            title={all}
                            value={chosen}
                            onChange={(e) => choose(key, e.target.value)}
                            disabled={!list.length}
                        >
                            <option value="">{all}</option>
                            {list.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {`${o.label || o.value} · ${fmtInt(o.count)}`}
                                </option>
                            ))}
                        </Select>
                    );
                })}
                <Select title="Timeline order" value={sort} onChange={(e) => reorder(e.target.value)}>
                    {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </Select>
                {active ? (
                    <Button variant="ghost" size="xs" onClick={clearAll}>
                        Clear {active} filter{active === 1 ? '' : 's'}
                    </Button>
                ) : null}
            </div>

            {error ? (
                <Card className="p-6 text-sm text-danger">{error.message}</Card>
            ) : !isLoading && !rows.length ? (
                <EmptyState
                    icon={Layers}
                    title={active ? 'Nothing matches those filters' : 'The ledger is empty'}
                    hint={active
                        ? 'Every dropdown value returns rows on its own — in combination they can still exclude everything.'
                        : 'Run scripts/ledger-backfill.mjs to load history, or generate something new.'}
                >
                    {active ? <Button variant="outline" onClick={clearAll}>Clear filters</Button> : null}
                </EmptyState>
            ) : (
                <>
                    <div className="overflow-x-auto rounded-lg border border-line">
                        <table className="min-w-full text-sm">
                            <thead className="bg-paper-2 text-[11px] uppercase tracking-[0.1em] text-ink-3">
                                <tr>
                                    {columns.map((c) => (
                                        <th key={c} className="whitespace-nowrap px-3 py-2.5 text-left font-semibold">{c}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                                {rows.map((row) => (
                                    <tr key={row._rowKey} className="transition-colors hover:bg-paper-2">
                                        {columns.map((c) => (
                                            <td key={c} className="max-w-md truncate whitespace-nowrap px-3 py-2.5 text-ink-2">
                                                <Cell column={c} value={row[c]} />
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="flex items-center justify-between text-xs text-ink-3">
                        <span>
                            {isLoading ? 'Loading…' : `${fmtInt(total)} row${total === 1 ? '' : 's'} · ${columns.length} columns`}
                            {total > PAGE_SIZE ? ` · showing ${fmtInt(page * PAGE_SIZE + 1)}–${fmtInt(Math.min(total, (page + 1) * PAGE_SIZE))}` : ''}
                        </span>
                        {pageCount > 1 ? (
                            <div className="flex items-center gap-2">
                                <span>Page {page + 1} of {fmtInt(pageCount)}</span>
                                <Button variant="outline" size="xs" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Prev</Button>
                                <Button variant="outline" size="xs" onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= pageCount}>Next</Button>
                            </div>
                        ) : null}
                    </div>
                </>
            )}
        </div>
    );
}
