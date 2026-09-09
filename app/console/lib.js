'use client';

// Console data helpers: SWR fetcher wired to the gateway error contract,
// mutation helpers, and shared formatters.

import useSWR from 'swr';

export async function fetcher(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const err = new Error(data?.message || `Request failed (${res.status})`);
        err.code = data?.code;
        err.detail = data;
        throw err;
    }
    return data;
}

export function useApi(path, opts = {}) {
    return useSWR(path, fetcher, { revalidateOnFocus: false, ...opts });
}

export async function sendJson(url, method, body) {
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
}

export const fmtUsd = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`);
export const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
export const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export function timeAgo(d) {
    if (!d) return '—';
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

// Console windows are IST days, matching the ledger's "Date (IST)" and the
// usage rollup's day buckets. Instants stay Z-format ISO (a '+05:30' offset
// inside a query string decodes as a space and breaks the timestamp).
export const istDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); // YYYY-MM-DD
export const istInstant = (ymd, time = '00:00:00') => new Date(`${ymd}T${time}+05:30`).toISOString();
export const monthStartIso = () => istInstant(`${istDate().slice(0, 7)}-01`);
export const dayStartIso = () => istInstant(istDate());

export const STATUS_TONE = {
    queued: 'amber', running: 'blue', succeeded: 'green',
    failed: 'red', cancelled: 'zinc', timed_out: 'red',
};
