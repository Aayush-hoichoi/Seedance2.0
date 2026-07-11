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

export const monthStartIso = () => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString();
};
export const dayStartIso = () => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString();
};

export const STATUS_TONE = {
    queued: 'amber', running: 'blue', succeeded: 'green',
    failed: 'red', cancelled: 'zinc', timed_out: 'red',
};
