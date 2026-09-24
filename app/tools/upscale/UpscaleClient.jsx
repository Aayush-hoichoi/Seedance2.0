'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Film, Loader2, Upload } from 'lucide-react';
import ProjectSelect from '../../seedance/ProjectSelect.jsx';
import ToolAccessGate, { BudgetChip, useToolStatus } from '../ToolAccessGate.jsx';
import StudioPicker from '../StudioPicker.jsx';
import UpscaleOptions from './UpscaleOptions.jsx';
import UpscaleRail, { ACTIVE } from './UpscaleRail.jsx';
import UpscalePreview from './UpscalePreview.jsx';
import { UPSCALE_DEFAULTS, UPSCALE_INPUT_EXTENSIONS, UPSCALE_LIMITS, isUpscaleInputName, buildUpscaleRequest, estimateUpscaleCost, estimateUpscaleMinutes, sourceTooLarge } from '../../../lib/byteplus/upscaleOptions.mjs';
import { resolveProjectId, rememberProjectId } from '../../../lib/seedance/projectChoice.mjs';
import { uploadToCdn } from '../../../lib/seedance/upload.js';
import { usd } from '../../../lib/seedance/money.mjs';

const OPTIONS_KEY = 'll_upscale_options_v1';
const loadOptions = () => {
    try { return { ...UPSCALE_DEFAULTS, ...JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}') }; } catch { return { ...UPSCALE_DEFAULTS }; }
};

export default function UpscaleClient() {
    const [projects, setProjects] = useState([]);
    const [projectId, setProjectId] = useState(null);
    const [projectsError, setProjectsError] = useState(null);
    const { status, error: statusError, refresh } = useToolStatus('upscale', projectId);

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

    const pickProject = (id) => { setProjectId(id); rememberProjectId(id, window.localStorage); };

    return (
        <div className="min-h-screen w-full bg-app-bg px-4 py-6 text-ink sm:pl-8 sm:pr-52">
            <div className="mx-auto max-w-6xl">
                <header className="mb-6 flex flex-wrap items-center gap-3">
                    <Link href="/tools" title="Back to tools" className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                        <ArrowLeft size={14} />
                    </Link>
                    <h1 className="font-display text-xl font-semibold">Upscale Video</h1>
                    <div className="ml-auto flex items-center gap-2">
                        {status?.allowed && <BudgetChip budget={status.budget} />}
                        {projects.length > 0 && <ProjectSelect projects={projects} value={projectId} onChange={pickProject} />}
                    </div>
                </header>
                {projectsError
                    ? <div className="text-xs text-danger">{projectsError}</div>
                    : (
                        <ToolAccessGate toolName="Upscale" status={status} error={statusError} projectId={projectId} onChanged={refresh}>
                            <UpscaleWorkspace projectId={projectId} budget={status?.budget} onSubmitted={refresh} />
                        </ToolAccessGate>
                    )}
            </div>
        </div>
    );
}

function UpscaleWorkspace({ projectId, budget, onSubmitted }) {
    const [options, setOptions] = useState(UPSCALE_DEFAULTS);
    const [source, setSource] = useState(null); // { file, previewUrl, seconds, width, height, url, uploading, error }
    const { jobs, loading, reload } = useUpscaleHistory(projectId);
    const [selectedId, setSelectedId] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => { setOptions(loadOptions()); }, []);
    useEffect(() => { try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)); } catch { /* ignore */ } }, [options]);
    useEffect(() => () => { if (source?.previewUrl) URL.revokeObjectURL(source.previewUrl); }, [source?.previewUrl]);

    const pickFile = async (file) => {
        if (!file) return;
        setError(null);
        if (!isUpscaleInputName(file.name)) { setError(`Unsupported file — BytePlus accepts ${UPSCALE_INPUT_EXTENSIONS.join(', ')}.`); return; }
        const previewUrl = URL.createObjectURL(file);
        setSource({ file, name: file.name, previewUrl, uploading: true });
        try {
            const { url } = await uploadToCdn(file);
            setSource((s) => (s?.file === file ? { ...s, url, uploading: false } : s));
        } catch (e) {
            setSource((s) => (s?.file === file ? { ...s, uploading: false, error: e.message || 'Upload failed.' } : s));
        }
    };

    // A studio generation is already stored on BytePlus, so its archive URL is
    // the source directly — no re-upload. Duration/size fill from the preview's
    // metadata (with the gallery's recorded duration as the starting value).
    const pickStudio = (item) => {
        setError(null);
        setPickerOpen(false);
        setSource({
            name: item.prompt?.slice(0, 80) || item.taskId,
            url: item.archiveUrl,
            previewUrl: item.archiveUrl,
            seconds: Number(item.duration) || undefined,
        });
    };

    // Browsers can't decode mkv/avi/wmv/flv/ts, so metadata never loads: ask for
    // duration + size by hand. Billing settles on BytePlus's reported output
    // duration, so a wrong manual value only skews the up-front estimate.
    const onPreviewError = () => setSource((s) => (s ? { ...s, manual: true } : s));
    const setManual = (k, v) => setSource((s) => (s ? { ...s, [k]: v === '' ? undefined : Number(v) } : s));

    const onMeta = (e) => {
        const v = e.currentTarget;
        setSource((s) => (s ? { ...s, seconds: v.duration, width: v.videoWidth, height: v.videoHeight } : s));
    };

    let validation = null;
    try { buildUpscaleRequest(options, { sourceSeconds: source?.seconds }); } catch (e) { validation = e.message; }
    const tooLarge = source && sourceTooLarge(source.width, source.height);
    const estimate = source ? estimateUpscaleCost(options, source) : null;
    const waitMin = source ? estimateUpscaleMinutes(options, source.seconds) : null;
    const selectedIdx = jobs.findIndex((j) => j.id === selectedId);
    const selected = selectedIdx >= 0 ? jobs[selectedIdx] : null;
    const overBudget = estimate != null && budget?.remainingUsd != null && estimate > budget.remainingUsd;
    const blocker = !source ? 'Pick a source video.'
        : source.uploading ? 'Uploading…'
            : source.error ? source.error
                : !source.seconds ? (source.manual ? 'Enter the clip duration.' : 'Reading video…')
                    : tooLarge ? 'Source is above 2K — BytePlus accepts input up to 2K only.'
                        : validation || (overBudget ? `Estimated ${usd(estimate)} exceeds your ${usd(budget.remainingUsd)} budget left.` : null);

    const submit = async () => {
        if (blocker || submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const r = await fetch('/api/seedance/upscale', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId, sourceUrl: source.url, sourceName: source.name, options,
                    source: { seconds: source.seconds, width: source.width, height: source.height },
                }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok || !d?.taskToken) throw new Error(d?.error || `Upscale failed (${r.status}).`);
            reload(); // the new job appears in the rail
            onSubmitted?.(); // refresh the budget chip
        } catch (e) {
            setError(e.message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <>
            {/* items-start + sticky: the preview stays in view while the long
                options rail scrolls, instead of leaving a dead area under the
                video and pushing the cost + submit below the fold. */}
            <div className="grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
                <section className="flex flex-col gap-3 lg:sticky lg:top-6">
                    <input ref={inputRef} type="file" accept={['video/*', ...UPSCALE_INPUT_EXTENSIONS.map((x) => `.${x}`)].join(',')} className="hidden" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
                    {source ? (
                        <div className="flex flex-col gap-2">
                            {source.manual ? (
                                <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-xl border border-line bg-paper-2 p-4 text-center">
                                    <Film size={22} className="text-ink-3" />
                                    <p className="max-w-sm text-xs leading-relaxed text-ink-3">Your browser can’t preview this format. Enter the clip’s details for the estimate — the final charge uses the real duration BytePlus reports.</p>
                                    <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
                                        <ManualField label="Duration" suffix="s" value={source.seconds} onChange={(v) => setManual('seconds', v)} />
                                        <ManualField label="Width" suffix="px" value={source.width} onChange={(v) => setManual('width', v)} />
                                        <ManualField label="Height" suffix="px" value={source.height} onChange={(v) => setManual('height', v)} />
                                    </div>
                                </div>
                            ) : (
                                <video src={source.previewUrl} controls muted playsInline onLoadedMetadata={onMeta} onError={onPreviewError} className="aspect-video w-full rounded-xl border border-line bg-black" />
                            )}
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
                                <span className="inline-flex items-center gap-1 text-ink-2"><Film size={12} /> {source.name}</span>
                                {source.seconds ? <span>{source.seconds.toFixed(1)}s</span> : null}
                                {source.width ? <span>{source.width}×{source.height}</span> : null}
                                {source.file && <span className={source.file.size > UPSCALE_LIMITS.maxInputBytes ? 'text-warn' : ''}>{(source.file.size / 1024 / 1024).toFixed(1)} MB{source.file.size > UPSCALE_LIMITS.maxInputBytes ? ' — above the recommended 10 GB' : ''}</span>}
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
                                <span className="text-[11px]">mp4 · mov · mkv · avi · flv · ts · wmv — input up to 2K, 10 GB</span>
                            </button>
                            <button type="button" onClick={() => setPickerOpen(true)}
                                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink">
                                Or pick a generated video from the studio
                            </button>
                        </div>
                    )}
                </section>

                {/* The rail caps at viewport height: options scroll inside it,
                    and the estimate + Upscale button stay pinned and visible. */}
                <aside className="flex flex-col gap-5 rounded-xl border border-line bg-paper-2 p-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)]">
                    <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
                        <UpscaleOptions value={options} onChange={setOptions} sourceSeconds={source?.seconds} />
                    </div>
                    <div className="flex flex-col gap-2 border-t border-line pt-4">
                        <div className="flex items-baseline justify-between text-xs">
                            <span className="text-ink-3">Estimated cost</span>
                            <span className="font-mono text-ink">{estimate != null ? usd(estimate) : '—'}</span>
                        </div>
                        <div className="flex items-baseline justify-between text-xs">
                            <span className="text-ink-3">Estimated wait</span>
                            <span className="font-mono text-ink-2">{waitMin ? `~${waitMin} min` : '—'}</span>
                        </div>
                        {options.fpsMode === 'source' && source && <p className="text-[11px] text-ink-3">Priced at ≤30 fps; a higher-fps source costs more. Final charge uses the real output duration.</p>}
                        {(blocker && source) || error ? <p className="text-xs text-danger">{error || blocker}</p> : null}
                        <button type="button" onClick={submit} disabled={!!blocker || submitting}
                            className="mt-1 inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-40">
                            {submitting && <Loader2 size={14} className="animate-spin" />} Upscale
                        </button>
                    </div>
                </aside>
            </div>
            {pickerOpen && <StudioPicker onClose={() => setPickerOpen(false)} onPick={pickStudio} />}
            <UpscaleRail jobs={jobs} loading={loading} selectedId={selectedId} onSelect={setSelectedId} />
            {selected && (
                <UpscalePreview
                    job={selected}
                    onClose={() => setSelectedId(null)}
                    onPrev={selectedIdx > 0 ? () => setSelectedId(jobs[selectedIdx - 1].id) : null}
                    onNext={selectedIdx < jobs.length - 1 ? () => setSelectedId(jobs[selectedIdx + 1].id) : null}
                    onReuse={(o) => setOptions({ ...UPSCALE_DEFAULTS, ...o })}
                />
            )}
        </>
    );
}


function ManualField({ label, suffix, value, onChange }) {
    return (
        <label className="flex items-center gap-1.5">
            <span className="text-ink-3">{label}</span>
            <input type="number" min={0} step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
                className="w-20 rounded-md border border-line bg-paper-3 px-2 py-1 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            <span className="text-ink-3">{suffix}</span>
        </label>
    );
}

const POLL_MS = 10_000;

// Server-backed history for this user + project. Polls while anything is
// queued/processing (the list request also nudges the worker forward).
function useUpscaleHistory(projectId) {
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [tick, setTick] = useState(0);
    const reload = () => setTick((t) => t + 1);
    const hasActive = jobs.some((j) => ACTIVE.has(j.status));

    useEffect(() => {
        if (!projectId) return undefined;
        let alive = true;
        fetch(`/api/seedance/upscale?list=1&projectId=${projectId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive && Array.isArray(d?.items)) setJobs(d.items); })
            .catch(() => { /* offline — keep the last list */ })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [projectId, tick]);

    useEffect(() => {
        if (!hasActive) return undefined;
        const id = setInterval(reload, POLL_MS);
        return () => clearInterval(id);
    }, [hasActive]);

    return { jobs, loading, reload };
}
