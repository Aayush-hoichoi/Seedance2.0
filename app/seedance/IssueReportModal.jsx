'use client';

// "Report issue" on a failed generation. Everything except the note is read-only
// context the studio already holds — the user's job is to describe what they were
// doing, not to re-type the error. Same chrome as BudgetRequestModal.jsx.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { friendlyError } from '../../lib/seedance/friendlyError.js';

export default function IssueReportModal({ job, projectName, userName, userRetries, onClose, onSent }) {
    const [note, setNote] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        const close = (event) => { if (event.key === 'Escape' && !sending) onClose(); };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
    }, [onClose, sending]);

    async function submit() {
        setSending(true);
        setError(null);
        try {
            const response = await fetch('/api/issues', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: job.projectId,
                    jobRef: {
                        taskId: job.taskId, genId: job.genId,
                        clientJobId: job.id, mediaType: job.mediaType,
                    },
                    modelId: job.model,
                    attempts: { userRetries, submitAttempts: job.submitAttempts },
                    error: job.error,
                    modeId: job.modeId,
                    options: job.options,
                    prompt: job.prompt,
                    note,
                }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error || 'Could not send the report.');
            onSent?.(data);
        } catch (e) {
            setError(e.message);
        } finally {
            setSending(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-4" onClick={() => !sending && onClose()}>
            <div role="dialog" aria-modal="true" aria-labelledby="issue-report-title"
                className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-white/10 bg-[#101014] p-5 shadow-2xl"
                onClick={(event) => event.stopPropagation()}>
                <div id="issue-report-title" className="text-base font-semibold text-white/90">Report this issue</div>
                <p className="mt-1 text-xs leading-relaxed text-white/50">
                    An admin gets the error log, your project, the model and how many times you tried. Add anything that helps.
                </p>

                <div className="mt-5 space-y-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <ReadOnly label="Project" value={projectName || '—'} />
                        <ReadOnly label="Reported by" value={userName || 'You'} />
                        <ReadOnly label="Model" value={job.model || '—'} />
                        <ReadOnly label="Attempts" value={`${userRetries} ${userRetries === 1 ? 'try' : 'tries'}`} />
                    </div>
                    <div>
                        <Label>Error</Label>
                        <div className="mt-1.5 rounded-md border border-red-500/20 bg-red-500/[0.06] px-2.5 py-2 text-xs leading-relaxed text-red-200">
                            {friendlyError(job.error) || 'Generation failed.'}
                        </div>
                        {job.error && job.error !== friendlyError(job.error) ? (
                            <pre className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 font-mono text-[10px] leading-relaxed text-white/45">{job.error}</pre>
                        ) : null}
                        {job.taskId ? <p className="mt-1.5 font-mono text-[10px] text-white/25 break-all">task {job.taskId}</p> : null}
                    </div>
                    <label className="block">
                        <Label>What were you doing? <span className="normal-case text-white/25">(optional)</span></Label>
                        <textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} autoFocus
                            placeholder="e.g. it fails every time with this reference image, but works without it"
                            className="mt-1.5 w-full resize-none rounded-md border border-white/10 bg-white/[0.05] px-2.5 py-2 text-xs text-white/90 placeholder:text-white/25 focus:border-primary/40 focus:outline-none" />
                    </label>
                </div>

                {error ? <div className="mt-4 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div> : null}
                <div className="mt-5 flex justify-end gap-2">
                    <button type="button" disabled={sending} onClick={onClose}
                        className="rounded-md border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/[0.1] disabled:opacity-40">Cancel</button>
                    <button type="button" disabled={sending} onClick={submit}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-accent-ink hover:bg-accent-hi disabled:opacity-40">
                        {sending ? 'Sending…' : 'Send to admin'}
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
            <div className="mt-1.5 flex h-9 items-center truncate rounded-md border border-white/10 bg-white/[0.025] px-2.5 text-xs text-white/65" title={value}>{value}</div>
        </div>
    );
}
