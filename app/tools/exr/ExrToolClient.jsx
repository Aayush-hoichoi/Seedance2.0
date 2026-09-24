'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Film, Loader2, Lock, Upload } from 'lucide-react';
import ProjectSelect from '../../seedance/ProjectSelect.jsx';
import StudioPicker from '../StudioPicker.jsx';
import { BudgetChip, useToolStatus } from '../ToolAccessGate.jsx';
import { EXR_DEFAULT_OPTIONS, EXR_FPS, EXR_RESOLUTIONS, EXR_TIERS, estimateExrCost, pricePerExrMinute } from '../../../lib/byteplus/exrPricing.mjs';
import { resolveProjectId, rememberProjectId } from '../../../lib/seedance/projectChoice.mjs';
import { uploadToCdn } from '../../../lib/seedance/upload.js';
import { downloadArchivedAsset } from '../../../lib/seedance/downloadAssets.js';
import { usd } from '../../../lib/seedance/money.mjs';

// ponytail: one job at a time, no history rail — finished EXR jobs are
// visible to admins in the console Enhance Queue; add a rail if users ask.
export default function ExrToolClient() {
    const [projects, setProjects] = useState([]);
    const [projectId, setProjectId] = useState(null);
    const [projectsError, setProjectsError] = useState(null);
    const [access, setAccess] = useState(null); // { granted, status } | null while loading
    // Only the budget half of the tool status matters here — EXR access has
    // its own approval flow above; the tool:exr budget is required like Upscale.
    const { status: toolStatus, refresh: refreshBudget } = useToolStatus('exr', projectId);

    useEffect(() => {
        fetch('/api/projects')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Could not load projects (${r.status}).`))))
            .then((d) => {
                const items = Array.isArray(d?.items) ? d.items : [];
                setProjects(items);
                setProjectId(resolveProjectId(items, window.location.search, window.localStorage));
            })
            .catch((e) => setProjectsError(e.message));
    }, []);

    useEffect(() => {
        if (!projectId) return undefined;
        let alive = true;
        setAccess(null);
        fetch(`/api/seedance/exr/access?projectId=${projectId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive) setAccess(d || { granted: false, status: 'unavailable' }); })
            .catch(() => { if (alive) setAccess({ granted: false, status: 'unavailable' }); });
        return () => { alive = false; };
    }, [projectId]);

    const pickProject = (id) => { setProjectId(id); rememberProjectId(id, window.localStorage); };

    return (
        <div className="min-h-screen w-full bg-app-bg px-4 py-6 text-ink sm:px-8">
            <div className="mx-auto max-w-6xl">
                <header className="mb-6 flex flex-wrap items-center gap-3">
                    <Link href="/tools" title="Back to tools" className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                        <ArrowLeft size={14} />
                    </Link>
                    <h1 className="font-display text-xl font-semibold">EXR Output</h1>
                    <div className="ml-auto flex items-center gap-2">
                        {toolStatus?.budget && <BudgetChip budget={toolStatus.budget} />}
                        {projects.length > 0 && <ProjectSelect projects={projects} value={projectId} onChange={pickProject} />}
                    </div>
                </header>
                {projectsError
                    ? <div className="text-xs text-danger">{projectsError}</div>
                    : !projectId || access == null || toolStatus == null
                        ? <div className="flex items-center gap-2 text-xs text-ink-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>
                        : !access.granted
                            ? <AccessGate access={access} projectId={projectId} onSent={setAccess} />
                            : !toolStatus.budget
                                ? (
                                    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-paper-2 p-8 text-center">
                                        <span className="grid h-10 w-10 place-items-center rounded-full bg-warn/10 text-warn"><Lock size={18} /></span>
                                        <h2 className="text-sm font-semibold">No EXR budget yet</h2>
                                        <p className="text-xs leading-relaxed text-ink-3">You have EXR access, but no EXR budget in this project. Ask an admin to create one (model “EXR Output”) in Console → Budgets.</p>
                                    </div>
                                )
                                : <ExrWorkspace projectId={projectId} onSpent={refreshBudget} />}
            </div>
        </div>
    );
}

// Request form mirroring the Upscale tool's gate: the user must say what
// they need EXR for; the note lands on the admin's Enhance Queue request.
function AccessGate({ access, projectId, onSent }) {
    const [note, setNote] = useState('');
    const [sending, setSending] = useState(false);
    const [err, setErr] = useState(null);
    const ok = note.trim().length >= 10;

    if (access.status === 'pending') {
        return (
            <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-paper-2 p-8 text-center">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-warn/10 text-warn"><Lock size={18} /></span>
                <h2 className="text-sm font-semibold">Request sent</h2>
                <p className="text-xs leading-relaxed text-ink-3">An admin is reviewing your EXR access request for this project.</p>
            </div>
        );
    }

    const send = async (e) => {
        e.preventDefault();
        if (!ok || sending) return;
        setSending(true);
        setErr(null);
        try {
            const r = await fetch('/api/seedance/exr/access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId, note: note.trim() }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) throw new Error(d?.error || `Request failed (${r.status}).`);
            onSent(d?.granted ? d : { ...access, status: 'pending' });
        } catch (e2) {
            setErr(e2.message);
        } finally {
            setSending(false);
        }
    };

    return (
        <form onSubmit={send} className="mx-auto flex max-w-md flex-col gap-3 rounded-xl border border-line bg-paper-2 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold"><Lock size={15} className="text-accent-hi" /> Request EXR access</div>
            <p className="text-xs leading-relaxed text-ink-3">
                {access.status === 'denied' ? 'Your last request was declined. ' : ''}EXR generation is locked per project and reviewed by an admin.
            </p>
            <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold text-ink-2">What will you use it for?</span>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={500} required
                    placeholder="e.g. 16-bit masters of the Season 10 hero shots for the grading pipeline, ~10 clips."
                    className="rounded-md border border-line bg-paper-3 px-2.5 py-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                <span className="text-[11px] text-ink-3">{ok ? ' ' : 'At least 10 characters.'}</span>
            </label>
            {err && <div className="text-xs text-danger">{err}</div>}
            <button type="submit" disabled={!ok || sending}
                className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                {sending ? 'Sending…' : 'Send request'}
            </button>
        </form>
    );
}

function ExrWorkspace({ projectId, onSpent }) {
    const [options, setOptions] = useState({ ...EXR_DEFAULT_OPTIONS });
    const [source, setSource] = useState(null); // { file?, name, previewUrl, seconds, url, uploading, manual, error }
    const [job, setJob] = useState(null); // { state: 'processing'|'succeeded'|'failed', url, archiveKey, taskId, error }
    const [pickerOpen, setPickerOpen] = useState(false);
    const inputRef = useRef(null);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    useEffect(() => () => { if (source?.previewUrl) URL.revokeObjectURL(source.previewUrl); }, [source?.previewUrl]);

    const setOption = (key, value) => setOptions((o) => ({ ...o, [key]: value }));

    const pickFile = async (file) => {
        if (!file) return;
        setJob(null);
        const previewUrl = URL.createObjectURL(file);
        setSource({ file, name: file.name, previewUrl, uploading: true });
        try {
            const { url } = await uploadToCdn(file);
            setSource((s) => (s?.file === file ? { ...s, url, uploading: false } : s));
        } catch (e) {
            setSource((s) => (s?.file === file ? { ...s, uploading: false, error: e.message || 'Upload failed.' } : s));
        }
    };

    // A studio generation already lives on BytePlus storage, so its archive
    // URL is the EXR source directly — no re-upload needed.
    const pickStudio = (item) => {
        setJob(null);
        setPickerOpen(false);
        setSource({
            name: item.prompt?.slice(0, 80) || item.taskId,
            url: item.archiveUrl,
            previewUrl: item.archiveUrl,
            seconds: Number(item.duration) || undefined,
        });
    };

    const rate = pricePerExrMinute(options);
    const estimate = estimateExrCost(options, source?.seconds);
    const busy = job?.state === 'processing';
    const blocker = !source ? 'Pick a source video.'
        : source.uploading ? 'Uploading…'
            : source.error ? source.error
                : !source.seconds ? (source.manual ? 'Enter the clip duration.' : 'Reading video…') : null;

    const generate = async () => {
        if (blocker || busy) return;
        setJob({ state: 'processing' });
        try {
            const r = await fetch('/api/seedance/exr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId, sourceUrl: source.url, options, durationSeconds: source.seconds }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok || !d?.taskToken) throw new Error(d?.error || `EXR request failed (${r.status}).`);
            for (let attempt = 0; attempt < 360; attempt += 1) {
                if (!alive.current) return;
                if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5000));
                const poll = await fetch(`/api/seedance/exr?task=${encodeURIComponent(d.taskToken)}`);
                const result = await poll.json().catch(() => null);
                if (!poll.ok) throw new Error(result?.error || `EXR status failed (${poll.status}).`);
                if (result?.status === 'queued' || result?.status === 'processing') continue;
                if (result?.status === 'succeeded' && result.url) {
                    if (alive.current) setJob({ state: 'succeeded', url: result.url, archiveKey: result.archiveKey || null, taskId: result.providerTaskId || null });
                    onSpent?.(); // budget chip reflects the settled spend
                    return;
                }
                throw new Error(result?.error || 'EXR generation failed.');
            }
            throw new Error('Timed out waiting for the EXR output — check the console Enhance Queue.');
        } catch (e) {
            if (alive.current) setJob({ state: 'failed', error: e.message });
        }
    };

    const download = () => downloadArchivedAsset(job.archiveKey, job.url, `${job.taskId || 'exr-output'}-16bit.mov`, job.taskId, { raw: true });

    return (
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
            <section className="flex flex-col gap-3">
                <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
                {source ? (
                    <div className="flex flex-col gap-2">
                        {source.manual ? (
                            <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-xl border border-line bg-paper-2 p-4 text-center">
                                <Film size={22} className="text-ink-3" />
                                <p className="max-w-sm text-xs leading-relaxed text-ink-3">Your browser can’t preview this format. Enter the clip duration for the estimate.</p>
                                <label className="flex items-center gap-1.5 text-xs">
                                    <span className="text-ink-3">Duration</span>
                                    <input type="number" min={0} step="any" value={source.seconds ?? ''} onChange={(e) => setSource((s) => (s ? { ...s, seconds: e.target.value === '' ? undefined : Number(e.target.value) } : s))}
                                        className="w-20 rounded-md border border-line bg-paper-3 px-2 py-1 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                                    <span className="text-ink-3">s</span>
                                </label>
                            </div>
                        ) : (
                            <video src={source.previewUrl} controls muted playsInline
                                onLoadedMetadata={(e) => { const v = e.currentTarget; setSource((s) => (s ? { ...s, seconds: v.duration } : s)); }}
                                onError={() => setSource((s) => (s ? { ...s, manual: true } : s))}
                                className="aspect-video w-full rounded-xl border border-line bg-black" />
                        )}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
                            <span className="inline-flex items-center gap-1 text-ink-2"><Film size={12} /> {source.name}</span>
                            {source.seconds ? <span>{source.seconds.toFixed(1)}s</span> : null}
                            {source.file && <span>{(source.file.size / 1024 / 1024).toFixed(1)} MB</span>}
                            {source.uploading && <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Uploading</span>}
                            <button type="button" onClick={() => setPickerOpen(true)} className="ml-auto text-accent-hi hover:underline">From studio</button>
                            <button type="button" onClick={() => inputRef.current?.click()} className="text-accent-hi hover:underline">Replace</button>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <button type="button" onClick={() => inputRef.current?.click()}
                            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]); }}
                            className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-paper-2 text-ink-3 transition-colors hover:border-accent/50 hover:text-ink-2">
                            <Upload size={22} />
                            <span className="text-sm font-medium">Drop a video or click to upload</span>
                            <span className="text-[11px]">Any video — output is a lossless 16-bit master (FFV1 MOV)</span>
                        </button>
                        <button type="button" onClick={() => setPickerOpen(true)}
                            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink">
                            Or pick a generated video from the studio
                        </button>
                    </div>
                )}
                {job?.state === 'succeeded' && (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ok/30 bg-ok/5 px-4 py-3">
                        <div className="text-xs">
                            <div className="font-semibold text-ink">16-bit output ready</div>
                            <div className="text-ink-3">FFV1 lossless · QuickTime MOV — plays in VLC/mpv, converts losslessly for editing.</div>
                        </div>
                        <button type="button" onClick={download} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink transition-opacity hover:opacity-90">
                            <Download size={13} /> Download
                        </button>
                    </div>
                )}
            </section>

            <aside className="flex flex-col gap-4 rounded-xl border border-line bg-paper-2 p-4 text-xs">
                <div className="grid gap-3">
                    <DetailRow label="Format" value="FFV1 lossless · QuickTime MOV" />
                    <DetailRow label="Bit depth" value="16-bit 4:4:4" />
                    <OptionSelect label="Enhancement" value={options.tier} onChange={(v) => setOption('tier', v)}>
                        {EXR_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </OptionSelect>
                    <OptionSelect label="Resolution" value={options.resolution} onChange={(v) => setOption('resolution', v)}>
                        {EXR_RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </OptionSelect>
                    <OptionSelect label="Frame rate" value={String(options.fps)} onChange={(v) => setOption('fps', Number(v))}>
                        {EXR_FPS.map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}
                    </OptionSelect>
                </div>
                <div className="flex flex-col gap-2 border-t border-line pt-4">
                    <div className="flex items-baseline justify-between">
                        <span className="text-ink-3">Rate</span>
                        <span className="font-mono text-ink-2">{usd(rate)} / min</span>
                    </div>
                    <div className="flex items-baseline justify-between">
                        <span className="text-ink-3">Estimated cost</span>
                        <span className="font-mono text-ink">{estimate != null ? usd(estimate) : '—'}</span>
                    </div>
                    {(job?.state === 'failed' || (blocker && source)) && <p className="text-danger">{job?.state === 'failed' ? job.error : blocker}</p>}
                    {busy && <p className="text-ink-3">Generating the 16-bit output — this can take several minutes. Keep this page open.</p>}
                    <button type="button" onClick={generate} disabled={!!blocker || busy}
                        className="mt-1 inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                        {busy && <Loader2 size={14} className="animate-spin" />} Generate EXR
                    </button>
                </div>
            </aside>
            {pickerOpen && <StudioPicker onClose={() => setPickerOpen(false)} onPick={pickStudio} />}
        </div>
    );
}

function DetailRow({ label, value }) {
    return (
        <div className="flex items-start justify-between gap-3">
            <span className="shrink-0 text-ink-3">{label}</span>
            <span className="text-right font-medium text-ink-2">{value}</span>
        </div>
    );
}

function OptionSelect({ label, value, onChange, children }) {
    return (
        <label className="flex items-center justify-between gap-3">
            <span className="shrink-0 text-ink-3">{label}</span>
            <select value={value} onChange={(e) => onChange(e.target.value)}
                className="min-w-28 rounded-md border border-line bg-paper-3 px-2 py-1.5 text-right font-medium text-ink-2 outline-none transition-colors hover:bg-paper-2 focus-visible:ring-2 focus-visible:ring-accent">
                {children}
            </select>
        </label>
    );
}
