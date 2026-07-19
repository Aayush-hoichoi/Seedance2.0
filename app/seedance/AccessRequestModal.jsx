'use client';

// Confirmation modal for a gated-model access request — replaces the old
// window.confirm. The user picks the quality tier they need (a higher tier
// includes every lower one) and can add a note; the admin still decides the
// final granted tier + expiry on approval. With currentCap set (the user
// already has the model, capped below what it supports) it runs in UPGRADE
// mode: only the tiers above the cap are offered. Esc / backdrop click
// cancels. Portaled to <body> (like MediaHoverPreview) so the docked prompt
// bar's transforms can't clip or reposition it.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { supportedResolutionsFor } from '../../lib/seedance/constants.js';

export default function AccessRequestModal({ modelId, modelName, defaultResolution, currentCap = null, onConfirm, onClose }) {
    const supported = supportedResolutionsFor(modelId) ?? [];
    const capIdx = supported.findIndex((t) => t.toLowerCase() === String(currentCap ?? '').toLowerCase());
    const upgrade = capIdx >= 0;
    const tiers = upgrade ? supported.slice(capIdx + 1) : supported;
    const initial = tiers.find((t) => t.toLowerCase() === String(defaultResolution ?? '').toLowerCase())
        || tiers[tiers.length - 1] || null;
    const [tier, setTier] = useState(initial);
    const [note, setNote] = useState('');
    const [sending, setSending] = useState(false);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const submit = async () => {
        setSending(true);
        try { await onConfirm({ maxResolution: tier, note: note.trim() || null }); }
        finally { setSending(false); }
    };

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
            <div
                role="dialog" aria-modal="true" aria-label={`Request access to ${modelName}`}
                className="w-full max-w-sm rounded-xl border border-white/10 bg-[#101014] p-5 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="text-sm font-semibold text-white/90">
                    {upgrade ? `Request higher quality on ${modelName}` : `Request access to ${modelName}`}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-white/50">
                    {upgrade
                        ? <>You currently have up to <span className="text-white/80">{currentCap}</span> on this project. An admin reviews the request and sets the final quality and expiry.</>
                        : 'Scoped to the current project. An admin reviews the request and sets the final quality and expiry.'}
                </p>

                {tiers.length > 0 && (
                    <div className="mt-4">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-white/40">Quality needed</div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {tiers.map((t) => (
                                <button
                                    key={t} type="button" onClick={() => setTier(t)}
                                    className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-all ${t === tier
                                        ? 'border-primary/40 bg-primary/10 text-primary'
                                        : 'border-white/10 bg-white/[0.06] text-white/70 hover:bg-white/[0.1]'}`}
                                >{t}</button>
                            ))}
                        </div>
                        <p className="mt-1.5 text-[11px] text-white/35">A higher tier includes every lower one.</p>
                    </div>
                )}

                <div className="mt-4">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-white/40">
                        Note for the admin <span className="normal-case text-white/25">(optional)</span>
                    </div>
                    <textarea
                        value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500}
                        placeholder="Why you need it…"
                        className="mt-1.5 w-full resize-none rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-2 text-xs text-white/90 placeholder:text-white/25 focus:border-primary/40 focus:outline-none"
                    />
                </div>

                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button" onClick={onClose}
                        className="rounded-md border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:bg-white/[0.1]"
                    >Cancel</button>
                    <button
                        type="button" disabled={sending} onClick={submit}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-accent-ink transition-colors hover:bg-accent-hi disabled:opacity-40"
                    >{sending ? 'Requesting…' : (upgrade ? 'Request upgrade' : 'Request access')}</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
