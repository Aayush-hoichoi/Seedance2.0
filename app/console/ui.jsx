'use client';

// Console design system — a thin façade over the vendored shadcn/ui
// components (components/ui/*), themed onto the locked tokens in /design.md
// via the semantic color mapping in tailwind.config.js. Pages keep the same
// API (Button, Select, Modal, DataTable, …); the primitives underneath are
// shadcn: Radix + CVA + Tailwind.

import * as React from 'react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button as UIButton } from '@/components/ui/button';
import { Input as UIInput } from '@/components/ui/input';
import {
    Select as UISelect, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card as UICard } from '@/components/ui/card';
import { Badge as UIBadge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
    useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel,
    getPaginationRowModel, flexRender,
} from '@tanstack/react-table';
import { ChevronUp, ChevronDown, ChevronsUpDown, Search, Loader2, CalendarDays } from 'lucide-react';

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
    return <UICard className={cn('rounded-lg border-line bg-paper-2 p-4 shadow-none', className)}>{children}</UICard>;
}

export function StatCard({ label, value, hint, tone = 'zinc' }) {
    return (
        <Card>
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3">{label}</div>
            <div className={cn('mt-1.5 font-mono text-2xl font-semibold tabular-nums', TONE_TEXT[tone] || 'text-ink')}>{value}</div>
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
        <UIBadge variant="outline" className={cn('gap-1 rounded-full text-[11px] font-medium', TONE_BG[tone], className)}>
            {children}
        </UIBadge>
    );
}

// House variants mapped onto shadcn's: primary→default, default→secondary,
// danger→destructive. `loading` shows a spinner and disables, as before.
const BUTTON_VARIANT = { default: 'secondary', primary: 'default', outline: 'outline', ghost: 'ghost', danger: 'destructive' };
const BUTTON_SIZE = { xs: 'h-7 px-2 text-xs', sm: 'h-8 px-3 text-xs', md: 'h-9 px-4 text-sm' };

export function Button({ variant = 'default', size = 'sm', className, loading, children, ...props }) {
    return (
        <UIButton
            variant={BUTTON_VARIANT[variant] || 'secondary'}
            size="sm"
            className={cn('gap-1.5 font-medium shadow-none [&_svg]:size-auto', BUTTON_SIZE[size], className)}
            disabled={loading || props.disabled}
            {...props}
        >
            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
            {children}
        </UIButton>
    );
}

export function Input({ className, ...props }) {
    return <UIInput className={cn('h-8 bg-paper-3 px-2.5 shadow-none', className)} {...props} />;
}

// Native-select API adapter over the shadcn (Radix) Select so the 13 existing
// call sites keep their <option> children and onChange(e.target.value) shape.
// Radix forbids item value "" — bridged through a sentinel both ways.
const EMPTY_VALUE = '__empty__';

function collectOptions(children, out = []) {
    for (const child of React.Children.toArray(children)) {
        if (!React.isValidElement(child)) continue;
        if (child.type === 'option') {
            out.push({
                value: String(child.props.value ?? child.props.children ?? ''),
                label: child.props.children,
                disabled: child.props.disabled,
            });
        } else if (child.props?.children) {
            collectOptions(child.props.children, out);
        }
    }
    return out;
}

export function Select({ className, children, value, onChange, title, disabled }) {
    const options = collectOptions(children);
    const current = String(value ?? '');
    return (
        <UISelect
            value={current === '' ? EMPTY_VALUE : current}
            onValueChange={(v) => onChange?.({ target: { value: v === EMPTY_VALUE ? '' : v } })}
            disabled={disabled}
        >
            <SelectTrigger title={title} className={cn('h-8 w-auto gap-1.5 bg-paper-3 px-2 text-sm shadow-none', className)}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-line bg-paper-1">
                {options.map((o, i) => (
                    <SelectItem key={`${o.value}-${i}`} value={o.value === '' ? EMPTY_VALUE : o.value} disabled={o.disabled}>
                        {o.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </UISelect>
    );
}

export function Modal({ open, onOpenChange, title, children, footer }) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(92vw,480px)] rounded-xl border-line bg-paper-1 p-5 sm:max-w-[480px]">
                <DialogHeader>
                    <DialogTitle className="font-display text-base font-semibold text-ink">{title}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">{children}</div>
                {footer ? <DialogFooter className="mt-2 gap-2 sm:gap-2">{footer}</DialogFooter> : null}
            </DialogContent>
        </Dialog>
    );
}

// Local-date helpers for the range picker: state stays 'YYYY-MM-DD' strings
// (what the usage API query builder expects), Dates only live inside the UI.
const toYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromYMD = (s) => {
    if (!s) return undefined;
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
};
const fmtDay = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// shadcn date-range picker: outline trigger + two-month range Calendar in a
// Popover. `to` may be '' (open-ended = up to now).
export function DateRangePicker({ from, to, onChange, className }) {
    const range = { from: fromYMD(from), to: fromYMD(to) };
    return (
        <Popover>
            <PopoverTrigger asChild>
                <Button variant="outline" className={cn('h-8 justify-start gap-2 px-3 text-xs font-normal', className)}>
                    <CalendarDays size={14} className="text-ink-3" />
                    {range.from
                        ? `${fmtDay(range.from)} – ${range.to ? fmtDay(range.to) : 'now'}`
                        : 'Pick a date range'}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto border-line bg-paper-1 p-0">
                <Calendar
                    mode="range"
                    numberOfMonths={2}
                    defaultMonth={range.from}
                    selected={range}
                    onSelect={(r) => onChange?.({ from: r?.from ? toYMD(r.from) : '', to: r?.to ? toYMD(r.to) : '' })}
                />
            </PopoverContent>
        </Popover>
    );
}

export function Field({ label, children }) {
    return (
        <label className="block">
            <Label asChild><span className="mb-1 block text-xs font-medium text-ink-2">{label}</span></Label>
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
    return <Progress value={pct} className="bg-paper-3" indicatorClassName={color} />;
}

// TanStack-powered grid rendered with shadcn Table primitives: sorting, quick
// filter, pagination — used by every list page.
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
                <div className="relative mb-3 w-64 max-w-full">
                    <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-ink-3" />
                    <Input className="pl-8" placeholder="Filter…" value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} />
                </div>
            ) : null}
            <div className="overflow-x-auto rounded-lg border border-line">
                <Table className="text-sm">
                    <TableHeader className="bg-paper-2 text-[11px] uppercase tracking-[0.1em] text-ink-3">
                        {table.getHeaderGroups().map((hg) => (
                            <TableRow key={hg.id} className="border-line hover:bg-transparent">
                                {hg.headers.map((h) => (
                                    <TableHead key={h.id} className="h-auto whitespace-nowrap px-3 py-2.5 font-semibold text-ink-3">
                                        {h.isPlaceholder ? null : (
                                            <button
                                                className={cn('inline-flex items-center gap-1', h.column.getCanSort() && 'hover:text-ink')}
                                                onClick={h.column.getToggleSortingHandler()}
                                                disabled={!h.column.getCanSort()}
                                            >
                                                {flexRender(h.column.columnDef.header, h.getContext())}
                                                {h.column.getCanSort() ? (
                                                    { asc: <ChevronUp size={12} />, desc: <ChevronDown size={12} /> }[h.column.getIsSorted()] ?? <ChevronsUpDown size={12} className="text-ink-3" />
                                                ) : null}
                                            </button>
                                        )}
                                    </TableHead>
                                ))}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody className="divide-y divide-line">
                        {rows.length ? rows.map((row) => (
                            <TableRow key={row.id} className="border-line transition-colors hover:bg-paper-2">
                                {row.getVisibleCells().map((cell) => (
                                    <TableCell key={cell.id} className="whitespace-nowrap px-3 py-2.5 text-ink-2">
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </TableCell>
                                ))}
                            </TableRow>
                        )) : (
                            <TableRow>
                                <TableCell colSpan={columns.length} className="px-3 py-10 text-center text-xs text-ink-3">{empty}</TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
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
