'use client';

// Console design system — token-driven primitives on Tailwind + Radix.
// Dark, dense, keyboard-friendly; every page composes from these.
// Colours reference the locked tokens in /design.md (bg-paper-*, text-ink-*,
// accent, ok/warn/danger) — never raw zinc/sky.

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import * as Dialog from '@radix-ui/react-dialog';
import {
    useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel,
    getPaginationRowModel, flexRender,
} from '@tanstack/react-table';
import { ChevronUp, ChevronDown, ChevronsUpDown, Search, X, Loader2 } from 'lucide-react';

export function PageHeader({ title, subtitle, children }) {
    return (
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
                <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
                {subtitle ? <p className="mt-1 text-sm text-ink-3">{subtitle}</p> : null}
            </div>
            <div className="flex items-center gap-2">{children}</div>
        </div>
    );
}

export function Card({ className, children }) {
    return <div className={clsx('rounded-lg border border-line bg-paper-2 p-4', className)}>{children}</div>;
}

export function StatCard({ label, value, hint, tone = 'zinc' }) {
    return (
        <Card>
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3">{label}</div>
            <div className={clsx('mt-1.5 font-mono text-2xl font-semibold tabular-nums', TONE_TEXT[tone] || 'text-ink')}>{value}</div>
            {hint ? <div className="mt-1 text-xs text-ink-3">{hint}</div> : null}
        </Card>
    );
}

const TONE_BG = {
    green: 'bg-ok/12 text-ok border-ok/30',
    red: 'bg-danger/12 text-danger border-danger/30',
    amber: 'bg-warn/12 text-warn border-warn/30',
    blue: 'bg-accent/12 text-accent-hi border-accent/30',
    violet: 'bg-accent/12 text-accent-hi border-accent/30',
    zinc: 'bg-paper-3 text-ink-2 border-line',
};
const TONE_TEXT = {
    green: 'text-ok', red: 'text-danger', amber: 'text-warn',
    blue: 'text-accent-hi', violet: 'text-accent-hi', zinc: 'text-ink',
};

export function Badge({ tone = 'zinc', children, className }) {
    return (
        <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', TONE_BG[tone], className)}>
            {children}
        </span>
    );
}

export function Button({ variant = 'default', size = 'sm', className, loading, children, ...props }) {
    const base = 'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';
    const variants = {
        default: 'bg-ink text-paper-0 hover:opacity-90',
        primary: 'bg-accent text-accent-ink hover:bg-accent-hi',
        outline: 'border border-line text-ink-2 hover:bg-paper-3 hover:text-ink',
        ghost: 'text-ink-2 hover:bg-paper-3 hover:text-ink',
        danger: 'bg-danger text-app-bg hover:brightness-110',
    };
    const sizes = { xs: 'h-7 px-2 text-xs', sm: 'h-8 px-3 text-xs', md: 'h-9 px-4 text-sm' };
    return (
        <button className={clsx(base, variants[variant], sizes[size], className)} disabled={loading || props.disabled} {...props}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
            {children}
        </button>
    );
}

export function Input({ className, ...props }) {
    return (
        <input
            className={clsx('h-8 w-full rounded-md border border-line bg-paper-3 px-2.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none', className)}
            {...props}
        />
    );
}

export function Select({ className, children, ...props }) {
    return (
        <select
            className={clsx('h-8 rounded-md border border-line bg-paper-3 px-2 text-sm text-ink focus:border-accent focus:outline-none', className)}
            {...props}
        >
            {children}
        </select>
    );
}

export function Modal({ open, onOpenChange, title, children, footer }) {
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
                <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-paper-1 p-5 shadow-2">
                    <div className="mb-4 flex items-center justify-between">
                        <Dialog.Title className="font-display text-base font-semibold text-ink">{title}</Dialog.Title>
                        <Dialog.Close asChild>
                            <button className="rounded-md p-1 text-ink-3 hover:bg-paper-3 hover:text-ink" aria-label="Close"><X size={16} /></button>
                        </Dialog.Close>
                    </div>
                    <div className="space-y-3">{children}</div>
                    {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

export function Field({ label, children }) {
    return (
        <label className="block">
            <div className="mb-1 text-xs font-medium text-ink-2">{label}</div>
            {children}
        </label>
    );
}

export function EmptyState({ icon: Icon, title, hint, children }) {
    return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line py-14 text-center">
            {Icon ? <Icon size={22} className="mb-2 text-ink-3" /> : null}
            <div className="font-display text-base font-medium text-ink">{title}</div>
            {hint ? <div className="mt-1 max-w-sm text-xs text-ink-3">{hint}</div> : null}
            {children ? <div className="mt-3">{children}</div> : null}
        </div>
    );
}

export function ProgressBar({ value, max, tone = 'blue' }) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    const color = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : { blue: 'bg-accent', green: 'bg-ok' }[tone] || 'bg-accent';
    return (
        <div className="h-2 w-full overflow-hidden rounded-full bg-paper-3">
            <div className={clsx('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
        </div>
    );
}

// TanStack-powered grid: sorting, quick filter, pagination — used by every list page.
export function DataTable({ columns, data, searchable = true, pageSize = 12, empty = 'Nothing here yet.' }) {
    const [sorting, setSorting] = useState([]);
    const [globalFilter, setGlobalFilter] = useState('');
    const table = useReactTable({
        data: data || [],
        columns,
        state: { sorting, globalFilter },
        onSortingChange: setSorting,
        onGlobalFilterChange: setGlobalFilter,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        initialState: { pagination: { pageSize } },
    });
    const rows = table.getRowModel().rows;
    const pageCount = table.getPageCount();
    return (
        <div>
            {searchable ? (
                <div className="mb-3 relative w-64 max-w-full">
                    <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
                    <Input className="pl-8" placeholder="Filter…" value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} />
                </div>
            ) : null}
            <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                    <thead className="bg-paper-2 text-left text-[11px] uppercase tracking-[0.1em] text-ink-3">
                        {table.getHeaderGroups().map((hg) => (
                            <tr key={hg.id}>
                                {hg.headers.map((h) => (
                                    <th key={h.id} className="whitespace-nowrap px-3 py-2.5 font-semibold">
                                        {h.isPlaceholder ? null : (
                                            <button
                                                className={clsx('inline-flex items-center gap-1', h.column.getCanSort() && 'hover:text-ink')}
                                                onClick={h.column.getToggleSortingHandler()}
                                                disabled={!h.column.getCanSort()}
                                            >
                                                {flexRender(h.column.columnDef.header, h.getContext())}
                                                {h.column.getCanSort() ? (
                                                    { asc: <ChevronUp size={12} />, desc: <ChevronDown size={12} /> }[h.column.getIsSorted()] ?? <ChevronsUpDown size={12} className="text-ink-3" />
                                                ) : null}
                                            </button>
                                        )}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody className="divide-y divide-line">
                        {rows.length ? rows.map((row) => (
                            <tr key={row.id} className="transition-colors hover:bg-paper-2">
                                {row.getVisibleCells().map((cell) => (
                                    <td key={cell.id} className="whitespace-nowrap px-3 py-2.5 text-ink-2">
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        )) : (
                            <tr><td colSpan={columns.length} className="px-3 py-10 text-center text-xs text-ink-3">{empty}</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
            {pageCount > 1 ? (
                <div className="mt-3 flex items-center justify-end gap-2 text-xs text-ink-3">
                    <span>Page {table.getState().pagination.pageIndex + 1} of {pageCount}</span>
                    <Button variant="outline" size="xs" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>Prev</Button>
                    <Button variant="outline" size="xs" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>Next</Button>
                </div>
            ) : null}
        </div>
    );
}

export function useColumns(defs) {
    return useMemo(() => defs, []); // eslint-disable-line react-hooks/exhaustive-deps
}
