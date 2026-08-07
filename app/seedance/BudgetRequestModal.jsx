'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { supportedResolutionsFor } from '../../lib/seedance/constants.js';

const ALL_MODELS = '*';
const ALL_MODEL_QUALITIES = ['standard', 'high', 'maximum'];

const money = (value) => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BudgetRequestModal({ projectId, onClose, onSent }) {
    const [context, setContext] = useState(null);
    const [error, setError] = useState(null);
    const [sending, setSending] = useState(false);
    const [modelId, setModelId] = useState(ALL_MODELS);
    const [quality, setQuality] = useState('high');
    const [increaseAmount, setIncreaseAmount] = useState('');
    const [reason, setReason] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        fetch(`/api/budget-requests?projectId=${projectId}`, { signal: controller.signal, cache: 'no-store' })
            .then(async (response) => {
                const data = await response.json().catch(() => null);
                if (!response.ok) throw new Error(data?.error || 'Could not load budget details.');
                setContext(data);
            })
            .catch((e) => { if (e.name !== 'AbortError') setError(e.message); });
        return () => controller.abort();
    }, [projectId]);

    useEffect(() => {
        const close = (event) => { if (event.key === 'Escape' && !sending) onClose(); };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
    }, [onClose, sending]);

    const selectedModel = context?.models?.find((model) => model.id === modelId);
    const tiers = useMemo(() => modelId === ALL_MODELS
        ? ALL_MODEL_QUALITIES
        : (supportedResolutionsFor(modelId) ?? []), [modelId]);
    const spent = modelId === ALL_MODELS
        ? Object.values(context?.spendByModel || {}).reduce((sum, value) => sum + Number(value), 0)
        : Number(context?.spendByModel?.[modelId] || 0);
    const currentLimit = Number(context?.limitByModel?.[modelId] || 0);

    function selectModel(next) {
        setModelId(next);
        const nextTiers = next === ALL_MODELS ? ALL_MODEL_QUALITIES : (supportedResolutionsFor(next) ?? []);
        setQuality(next === ALL_MODELS ? 'high' : nextTiers[nextTiers.length - 1] || '');
    }

    async function submit() {
        if (!(Number(increaseAmount) > 0) || !quality) return;
        setSending(true);
        setError(null);
        try {
            const response = await fetch('/api/budget-requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId, modelId, quality, increaseAmount: Number(increaseAmount), reason }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error || 'Could not send the request.');
            onSent?.(data.request);
        } catch (e) {
            setError(e.message);
        } finally {
            setSending(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-4" onClick={() => !sending && onClose()}>
            <div role="dialog" aria-modal="true" aria-labelledby="budget-request-title"
                className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-white/10 bg-[#101014] p-5 shadow-2xl"
                onClick={(event) => event.stopPropagation()}>
                <div id="budget-request-title" className="text-base font-semibold text-white/90">Request more budget</div>
                <p className="mt-1 text-xs leading-relaxed text-white/50">
                    Choose one model or every model. The approved quality includes that tier and every lower tier.
                </p>

                {!context && !error ? <div className="mt-5 h-40 animate-pulse rounded-lg bg-white/[0.05]" /> : null}
                {context ? (
                    <div className="mt-5 space-y-4">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <ReadOnly label="Project" value={context.project.name} />
                            <ReadOnly label="Requested by" value={context.user.name || context.user.email} />
                        </div>
                        <label className="block">
                            <Label>Models</Label>
                            <select value={modelId} onChange={(e) => selectModel(e.target.value)}
                                className="mt-1.5 h-9 w-full rounded-md border border-white/10 bg-white/[0.05] px-2.5 text-xs text-white/90 focus:border-primary/40 focus:outline-none">
                                <option value={ALL_MODELS}>All models</option>
                                {(context.models || []).map((model) => <option key={model.id} value={model.id}>{model.display_name} · {model.category}</option>)}
                            </select>
                        </label>
                        <div>
                            <Label>Quality needed</Label>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {tiers.map((tier) => (
                                    <button key={tier} type="button" onClick={() => setQuality(tier)}
                                        className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold capitalize ${quality === tier
                                            ? 'border-primary/40 bg-primary/10 text-primary'
                                            : 'border-white/10 bg-white/[0.05] text-white/65 hover:bg-white/[0.1]'}`}>
                                        {tier}
                                    </button>
                                ))}
                            </div>
                            <p className="mt-1.5 text-[11px] text-white/35">
                                {modelId === ALL_MODELS
                                    ? 'The selected level maps to the closest supported tier on each model.'
                                    : `${selectedModel?.display_name || 'This model'} will be available up to ${quality || 'the selected tier'}.`}
                            </p>
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <ReadOnly label="Spent this month" value={money(spent)} />
                            <ReadOnly label="Current monthly limit" value={currentLimit ? money(currentLimit) : 'No personal limit'} />
                        </div>
                        <label className="block">
                            <Label>Required increase (USD)</Label>
                            <input type="number" min="0.01" step="0.01" value={increaseAmount} onChange={(e) => setIncreaseAmount(e.target.value)}
                                placeholder="e.g. 100" autoFocus
                                className="mt-1.5 h-9 w-full rounded-md border border-white/10 bg-white/[0.05] px-2.5 text-xs text-white/90 placeholder:text-white/25 focus:border-primary/40 focus:outline-none" />
                        </label>
                        <label className="block">
                            <Label>Reason <span className="normal-case text-white/25">(optional)</span></Label>
                            <textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
                                placeholder="What will this additional budget be used for?"
                                className="mt-1.5 w-full resize-none rounded-md border border-white/10 bg-white/[0.05] px-2.5 py-2 text-xs text-white/90 placeholder:text-white/25 focus:border-primary/40 focus:outline-none" />
                        </label>
                    </div>
                ) : null}

                {error ? <div className="mt-4 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div> : null}
                <div className="mt-5 flex justify-end gap-2">
                    <button type="button" disabled={sending} onClick={onClose}
                        className="rounded-md border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/[0.1] disabled:opacity-40">Cancel</button>
                    <button type="button" disabled={!context || sending || !(Number(increaseAmount) > 0) || !quality} onClick={submit}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-accent-ink hover:bg-accent-hi disabled:opacity-40">
                        {sending ? 'Sending…' : 'Send request'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

function Label({ children }) {
    return <div className="text-[11px] font-medium uppercase tracking-wide text-white/40">{children}</div>;
}

function ReadOnly({ label, value }) {
    return (
        <div>
            <Label>{label}</Label>
            <div className="mt-1.5 flex h-9 items-center rounded-md border border-white/10 bg-white/[0.025] px-2.5 text-xs text-white/65">{value}</div>
        </div>
    );
}
