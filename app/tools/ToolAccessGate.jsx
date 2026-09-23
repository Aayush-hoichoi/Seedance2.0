'use client';

import { useCallback, useEffect, useState } from 'react';
import { Lock, Clock, WalletCards } from 'lucide-react';
import { usd } from '../../lib/seedance/money.mjs';

// Loads access + budget for one tool in one project. The tool's own submit
// route re-checks all of it; this only drives the UI.
export function useToolStatus(slug, projectId) {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const refresh = useCallback(async () => {
        if (!projectId) return;
        setError(null);
        try {
            const r = await fetch(`/api/tools/status?tool=${encodeURIComponent(slug)}&projectId=${projectId}`);
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error || `Could not load access (${r.status}).`);
            setStatus(d);
        } catch (e) {
            setError(e.message);
        }
    }, [slug, projectId]);
    useEffect(() => { setStatus(null); refresh(); }, [refresh]);
    return { status, error, refresh };
}

// Renders children only when the user has access AND a tool budget; otherwise
// the request-access form, the pending notice, or the no-budget notice.
export default function ToolAccessGate({ toolName, status, error, projectId, onChanged, children }) {
    if (error) return <Notice icon={Lock} tone="danger" title="Couldn’t check access">{error}</Notice>;
    if (!status) return <div className="py-16 text-center text-xs text-ink-3">Checking access…</div>;
    if (!status.allowed) {
        return status.requestStatus === 'pending'
            ? <Notice icon={Clock} tone="warn" title="Request sent">An admin is reviewing your {toolName} access request for this project.</Notice>
            : <RequestAccess toolId={status.toolId} toolName={toolName} projectId={projectId} onSent={onChanged} denied={status.requestStatus === 'revoked'} />;
    }
    if (!status.budget) {
        return <Notice icon={WalletCards} tone="warn" title="No budget yet">You have {toolName} access, but no {toolName} budget in this project. Ask an admin to set one in Console → Budgets.</Notice>;
    }
    return children;
}

export function BudgetChip({ budget }) {
    if (!budget || budget.remainingUsd == null) return null;
    const low = budget.limitUsd > 0 && budget.remainingUsd / budget.limitUsd < 0.1;
    return (
        <span title="Budget left for this tool" className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs ${low ? 'border-warn/30 bg-warn/10 text-warn' : 'border-line bg-paper-2 text-ink-2'}`}>
            <WalletCards size={13} /> {usd(budget.remainingUsd)} <span className="text-ink-3">of {usd(budget.limitUsd)}</span>
        </span>
    );
}

function RequestAccess({ toolId, toolName, projectId, onSent, denied }) {
    const [note, setNote] = useState('');
    const [sending, setSending] = useState(false);
    const [err, setErr] = useState(null);
    const ok = note.trim().length >= 10;
    const send = async (e) => {
        e.preventDefault();
        if (!ok) return;
        setSending(true);
        setErr(null);
        try {
            const r = await fetch('/api/access/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: toolId, projectId, note: note.trim() }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error || `Request failed (${r.status}).`);
            onSent?.();
        } catch (e2) {
            setErr(e2.message);
        } finally {
            setSending(false);
        }
    };
    return (
        <form onSubmit={send} className="mx-auto flex max-w-md flex-col gap-3 rounded-xl border border-line bg-paper-2 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold"><Lock size={15} className="text-accent-hi" /> Request {toolName} access</div>
            <p className="text-xs leading-relaxed text-ink-3">
                {denied ? 'Your last request was declined. ' : ''}Access is per project and reviewed by an admin, who also sets your {toolName} budget.
            </p>
            <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink-2">What will you use it for?</span>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={500} required
                    placeholder="e.g. Upscaling the 720p Season 10 teaser shots to 4K for the festival cut, ~20 clips of 10s."
                    className="rounded-md border border-line bg-paper-3 px-2.5 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                <span className="text-[11px] text-ink-3">{ok ? ' ' : 'At least 10 characters.'}</span>
            </label>
            {err && <div className="text-xs text-danger">{err}</div>}
            <button type="submit" disabled={!ok || sending}
                className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                {sending ? 'Sending…' : 'Send request'}
            </button>
        </form>
    );
}

function Notice({ icon: Icon, tone, title, children }) {
    const toneCls = tone === 'danger' ? 'text-danger' : 'text-warn';
    return (
        <div className="mx-auto flex max-w-md flex-col items-center gap-2 rounded-xl border border-line bg-paper-2 p-6 text-center">
            <Icon size={20} className={toneCls} />
            <div className="text-sm font-semibold">{title}</div>
            <p className="text-xs leading-relaxed text-ink-3">{children}</p>
        </div>
    );
}
