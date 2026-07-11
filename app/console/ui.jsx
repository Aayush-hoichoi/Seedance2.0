'use client';

// Console design system — shadcn-style primitives on Tailwind + Radix.
// Dark, dense, keyboard-friendly; every page composes from these.

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
                <h1 className="text-xl font-semibold tracking-tight text-zinc-100">{title}</h1>
                {subtitle ? <p className="mt-1 text-sm text-zinc-400">{subtitle}</p> : null}
            </div>
            <div className="flex items-center gap-2">{children}</div>
        </div>
    );
}

export function Card({ className, children }) {
    return <div className={clsx('rounded-xl border border-zinc-800 bg-zinc-900/60 p-4', className)}>{children}</div>;
}

export function StatCard({ label, value, hint, tone = 'zinc' }) {
    return (
        <Card>
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
            <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', TONE_TEXT[tone] || 'text-zinc-100')}>{value}</div>
            {hint ? <div className="mt-1 text-xs text-zinc-500">{hint}</div> : null}
        </Card>
    );
}

const TONE_BG = {
    green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    red: 'bg-red-500/15 text-red-300 border-red-500/30',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    blue: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    violet: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    zinc: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
};
const TONE_TEXT = {
    green: 'text-emerald-300', red: 'text-red-300', amber: 'text-amber-300',
    blue: 'text-sky-300', violet: 'text-violet-300', zinc: 'text-zinc-100',
};

export function Badge({ tone = 'zinc', children, className }) {
    return (
        <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', TONE_BG[tone], className)}>
            {children}
        </span>
    );
}

export function Button({ variant = 'default', size = 'sm', className, loading, children, ...props }) {
    const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';
    const variants = {
        default: 'bg-zinc-100 text-zinc-900 hover:bg-white',
        primary: 'bg-sky-600 text-white hover:bg-sky-500',
        outline: 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800',
        ghost: 'text-zinc-300 hover:bg-zinc-800',
        danger: 'bg-red-600/90 text-white hover:bg-red-500',
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
            className={clsx('h-8 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-600 focus:outline-none', className)}
            {...props}
        />
    );
}

export function Select({ className, children, ...props }) {
    return (
        <select
            className={clsx('h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 focus:border-sky-600 focus:outline-none', className)}
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
                <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
                    <div className="mb-4 flex items-center justify-between">
                        <Dialog.Title className="text-sm font-semibold text-zinc-100">{title}</Dialog.Title>
                        <Dialog.Close asChild>
                            <button className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" aria-label="Close"><X size={16} /></button>
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
            <div className="mb-1 text-xs font-medium text-zinc-400">{label}</div>
            {children}
        </label>
    );
}

export function EmptyState({ icon: Icon, title, hint, children }) {
    return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 py-14 text-center">
            {Icon ? <Icon size={22} className="mb-2 text-zinc-600" /> : null}
            <div className="text-sm font-medium text-zinc-300">{title}</div>
            {hint ? <div className="mt-1 max-w-sm text-xs text-zinc-500">{hint}</div> : null}
            {children ? <div className="mt-3">{children}</div> : null}
        </div>
    );
}

export function ProgressBar({ value, max, tone = 'blue' }) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    const color = pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-amber-500' : pct >= 80 ? 'bg-amber-400' : { blue: 'bg-sky-500', green: 'bg-emerald-500' }[tone] || 'bg-sky-500';
    return (
        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
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
                <div className="mb-3 relative w-64">
                    <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <Input className="pl-8" placeholder="Filter…" value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} />
                </div>
            ) : null}
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
                <table className="w-full text-sm">
                    <thead className="bg-zinc-900/80 text-left text-xs text-zinc-400">
                        {table.getHeaderGroups().map((hg) => (
                            <tr key={hg.id}>
                                {hg.headers.map((h) => (
                                    <th key={h.id} className="whitespace-nowrap px-3 py-2.5 font-medium">
                                        {h.isPlaceholder ? null : (
                                            <button
                                                className={clsx('inline-flex items-center gap-1', h.column.getCanSort() && 'hover:text-zinc-200')}
                                                onClick={h.column.getToggleSortingHandler()}
                                                disabled={!h.column.getCanSort()}
                                            >
                                                {flexRender(h.column.columnDef.header, h.getContext())}
                                                {h.column.getCanSort() ? (
                                                    { asc: <ChevronUp size={12} />, desc: <ChevronDown size={12} /> }[h.column.getIsSorted()] ?? <ChevronsUpDown size={12} className="text-zinc-600" />
                                                ) : null}
                                            </button>
                                        )}
                                    </th>
                                ))}
                            </tr>
                        ))}
                    </thead>
                    <tbody className="divide-y divide-zinc-800/80">
                        {rows.length ? rows.map((row) => (
                            <tr key={row.id} className="hover:bg-zinc-900/50">
                                {row.getVisibleCells().map((cell) => (
                                    <td key={cell.id} className="whitespace-nowrap px-3 py-2.5 text-zinc-300">
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        )) : (
                            <tr><td colSpan={columns.length} className="px-3 py-10 text-center text-xs text-zinc-500">{empty}</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
            {pageCount > 1 ? (
                <div className="mt-3 flex items-center justify-end gap-2 text-xs text-zinc-400">
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
