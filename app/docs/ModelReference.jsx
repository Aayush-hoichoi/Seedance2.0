'use client';

// Interactive model/mode reference — the docs-page explorer. Everything shown
// here is read live from lib/seedance/constants.js and the pricing tables, so
// the docs can never drift from what the studio actually enforces.

import { useState } from 'react';
import clsx from 'clsx';
import { Lock, Unlock, Check, X, Info } from 'lucide-react';
import {
    MODELS, IMAGE_MODELS, MODES, RATIOS, IMAGE_RATIOS,
    supportedResolutionsFor, durationMaxFor, modeAllowedForModel,
    modeForModel,
} from '@/lib/seedance/constants.js';
import { estimateCost } from '@/lib/seedance/pricing.mjs';
import { imageCost } from '@/lib/gateway/imagePricing.mjs';

const usd = (v) => (v == null ? '—' : `$${v.toFixed(v < 0.1 ? 3 : 2)}`);

function Pill({ active, onClick, children }) {
    return (
        <button type="button" onClick={onClick}
            className={clsx('rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
                active ? 'border-accent/60 bg-accent/15 text-accent-hi' : 'border-line bg-paper-2 text-ink-2 hover:text-ink')}>
            {children}
        </button>
    );
}

function Row({ label, children }) {
    return (
        <div className="grid grid-cols-[140px_1fr] gap-3 border-b border-line/60 py-2.5 text-sm last:border-0 sm:grid-cols-[180px_1fr]">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">{label}</div>
            <div className="text-ink-2">{children}</div>
        </div>
    );
}

function Tag({ ok, children }) {
    return (
        <span className={clsx('mr-1.5 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold',
            ok === false ? 'border-line text-ink-3 line-through opacity-60' : 'border-line bg-paper-3 text-ink-2')}>
            {children}
        </span>
    );
}

function AccessBadge({ gated }) {
    return gated ? (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 py-0.5 text-xs font-semibold text-warn">
            <Lock size={11} /> Requires approved access request
        </span>
    ) : (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-ok/30 bg-ok/10 px-2 py-0.5 text-xs font-semibold text-ok">
            <Unlock size={11} /> Open to everyone
        </span>
    );
}

// Per-model guidance that isn't derivable from the catalog flags alone —
// condensed from the ModelArk catalog comments and the official Seedance /
// Gemini / OpenAI docs.
const VIDEO_NOTES = {
    full_2_5: 'Highest tier. Up to 30s per clip, biggest multi-reference caps (30 images / 10 videos / 10 audio, audio can be used alone). Aspect ratio is inherited from your input on edit/extend and first-frame tasks — the picker is ignored there. 4K is not available on this tier.',
    full: 'The full Seedance 2.0 tier — the only video tier with native 4K. Up to 15s per clip.',
    fast: 'Faster, cheaper variant of Seedance 2.0. Capped at 720p and 15s.',
    mini: 'The open default — no access request needed. Capped at 720p and 15s.',
    pro_1_5: 'Open tier for text→video and image→video only: no reference-based modes (Motion Capture, Green Screen, Mannequin, Customized, Multi reference are unavailable).',
    full_sensitive: 'Same model and pricing as Seedance 2.0, behind a dedicated endpoint whose moderation accepts production footage (e.g. drama scenes with blood/violence) that the shared endpoints flag. Use it when a normal generation fails with a sensitive-content error.',
};

const IMAGE_NOTES = {
    'nano-banana-2': 'Open default (Google Gemini Flash Image). Output may cap near 1K server-side even when 2K is selected.',
    'nano-banana-pro': 'Google Gemini 3 Pro Image. Best reference handling — up to 14 reference images per prompt.',
    'seedream-5.0-pro': 'BytePlus Seedream. Its minimum output is ~2K, so a 1K tier is not offered.',
    'chatgpt-image-2': 'OpenAI GPT Image 2 (via kie.ai). Ratio and resolution are coupled: 5:4 and 4:5 render at 1K no matter which tier you pick — the price follows the tier actually rendered.',
    'chatgpt-image-2.5': 'OpenAI GPT Image 2.5, direct. Two engine variants (Flare = fast everyday, Sunburst = premium edits, slower) and three quality levels (low/medium/high) — quality scales the price. 4K is experimental on OpenAI’s side.',
    'cinematic-studio': 'Nano Banana Pro plus the Cinematic Cameras panel and prompt structuring. Separately access-controlled — its own request and grant.',
};

const MODE_NOTES = {
    motion_capture: 'Keeps the video’s performance (motion, audio, camera) and swaps everything you describe. The prompt enhancer restructures your text automatically.',
    green_screen: 'Composites a green-screen performance into a new scene. Performance and audio stay locked.',
    performance_transfer: 'The mirror of Motion Capture: identity and background come from your image, only the acting is transferred from the video.',
    mannequin_auto: 'No prompt needed — a fixed conversion brief turns your green-screen clip into a silent white-mannequin motion twin, ready for Mannequin mode.',
    mannequin: 'The mannequin supplies only motion; your images supply identity and scene. Source is silent, so Audio may stay off.',
    customized: 'Environment replacement for automotive/VFX plates: hero subjects and camera stay locked, the background is rebuilt from your prompt and reference images.',
    t2v: 'Pure text to video.',
    i2v_first: 'One image becomes the first frame of the clip.',
    first_last: 'Morphs between a start and an end image.',
    reference: 'The free-form multi-reference mode. Caps are per model — Seedance 2.5 takes 30 images / 10 videos / 10 audio and accepts audio alone; the 2.0 family stops at 9/3/3 and audio can’t be used alone.',
};

export function VideoModelExplorer() {
    const [sel, setSel] = useState(MODELS[0].id);
    const m = MODELS.find((x) => x.id === sel);
    const res = supportedResolutionsFor(m.id) ?? [];
    const maxDur = durationMaxFor(m.id);
    const allowedModes = MODES.filter((mode) => modeAllowedForModel(mode, m));
    const blockedModes = MODES.filter((mode) => !modeAllowedForModel(mode, m));
    return (
        <div>
            <div className="mb-4 flex flex-wrap gap-2">
                {MODELS.map((x) => <Pill key={x.id} active={x.id === sel} onClick={() => setSel(x.id)}>{x.name}</Pill>)}
            </div>
            <div className="rounded-xl border border-line bg-paper-1 px-4 py-2">
                <Row label="Access"><AccessBadge gated={m.gated} /></Row>
                <Row label="Resolutions">
                    {['480p', '720p', '1080p', '4k'].map((r) => <Tag key={r} ok={res.includes(r)}>{r}</Tag>)}
                </Row>
                <Row label="Duration">4–{maxDur} seconds (any whole second), or “Auto” to let the model decide. Video edits always use Auto — the result inherits the source clip’s length.</Row>
                <Row label="Aspect ratios">
                    {RATIOS.map((r) => <Tag key={r}>{r}</Tag>)}
                    {m.kind === 'full_2_5' && <div className="mt-1.5 flex items-start gap-1.5 text-xs text-ink-3"><Info size={12} className="mt-0.5 shrink-0" /> On Seedance 2.5, edit/extend tasks and first-frame tasks ignore the ratio picker — the output follows the input video/image.</div>}
                </Row>
                <Row label="Reference modes">
                    {m.supportsReference !== false
                        ? <span className="inline-flex items-center gap-1 text-ok"><Check size={13} /> Supported</span>
                        : <span className="inline-flex items-center gap-1 text-ink-3"><X size={13} /> Not supported — text→video, image→video and first+last frame only</span>}
                </Row>
                <Row label="Modes">
                    {allowedModes.map((mode) => <Tag key={mode.id}>{mode.name}</Tag>)}
                    {blockedModes.map((mode) => <Tag key={mode.id} ok={false}>{mode.name}</Tag>)}
                </Row>
                <Row label="Estimated cost">
                    <PriceTable kind={m.kind} resolutions={res} maxDur={maxDur} />
                    <div className="mt-1.5 text-xs text-ink-3">Estimates for a clip with no video input; attaching a video raises the cost (~17% in practice). The final charge is settled from the provider’s actual token count.</div>
                </Row>
                {VIDEO_NOTES[m.kind] && <Row label="Notes">{VIDEO_NOTES[m.kind]}</Row>}
            </div>
        </div>
    );
}

function PriceTable({ kind, resolutions, maxDur }) {
    const durations = [5, 10, maxDur].filter((d, i, a) => a.indexOf(d) === i);
    return (
        <div className="overflow-x-auto">
            <table className="text-xs">
                <thead><tr className="text-left text-ink-3">
                    <th className="py-1 pr-4 font-semibold">Resolution</th>
                    {durations.map((d) => <th key={d} className="py-1 pr-4 font-semibold">{d}s</th>)}
                </tr></thead>
                <tbody>
                    {resolutions.map((r) => (
                        <tr key={r} className="border-t border-line/60">
                            <td className="py-1 pr-4 font-semibold text-ink-2">{r}</td>
                            {durations.map((d) => <td key={d} className="py-1 pr-4">{usd(estimateCost({ kind, resolution: r, duration: d }))}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function ImageModelExplorer() {
    const [sel, setSel] = useState(IMAGE_MODELS[0].id);
    const m = IMAGE_MODELS.find((x) => x.id === sel);
    return (
        <div>
            <div className="mb-4 flex flex-wrap gap-2">
                {IMAGE_MODELS.map((x) => <Pill key={x.id} active={x.id === sel} onClick={() => setSel(x.id)}>{x.name}</Pill>)}
            </div>
            <div className="rounded-xl border border-line bg-paper-1 px-4 py-2">
                <Row label="Access"><AccessBadge gated={m.gated} /></Row>
                <Row label="Resolutions">
                    {['1K', '2K', '4K'].map((r) => <Tag key={r} ok={m.resolutions.includes(r)}>{r}</Tag>)}
                    {m.kind === 'chatgpt_image_2' && <div className="mt-1.5 flex items-start gap-1.5 text-xs text-ink-3"><Info size={12} className="mt-0.5 shrink-0" /> At 5:4 or 4:5 this model always renders 1K — higher tiers are capped (and billed) down automatically.</div>}
                </Row>
                <Row label="Aspect ratios">{IMAGE_RATIOS.map((r) => <Tag key={r}>{r}</Tag>)}</Row>
                <Row label="Reference images">Up to {m.maxRefImages} per prompt</Row>
                {m.variants && <Row label="Variants">{m.variants.map((v) => <Tag key={v}>{v}</Tag>)} Flare is the fast everyday engine; Sunburst is slower, for premium edits.</Row>}
                {m.qualities && <Row label="Quality">{m.qualities.map((q) => <Tag key={q}>{q}</Tag>)} Higher quality costs more.</Row>}
                <Row label="Cost per image">
                    <div className="flex flex-wrap gap-x-5 gap-y-1">
                        {m.resolutions.map((r) => (
                            <span key={r}><span className="font-semibold text-ink-2">{r}</span> {usd(imageCost(m.kind, 'interactive', 1, r, m.qualities ? 'medium' : null))}</span>
                        ))}
                    </div>
                    {m.qualities && <div className="mt-1 text-xs text-ink-3">Shown at medium quality.</div>}
                </Row>
                {IMAGE_NOTES[m.id] && <Row label="Notes">{IMAGE_NOTES[m.id]}</Row>}
            </div>
        </div>
    );
}

export function ModeExplorer() {
    const [sel, setSel] = useState(MODES[0].id);
    const [modelId, setModelId] = useState(MODELS[0].id);
    const model = MODELS.find((x) => x.id === modelId);
    const mode = modeForModel(MODES.find((x) => x.id === sel), model.kind);
    const allowed = modeAllowedForModel(mode, model);
    const kindLabel = { image: 'images', video: 'videos', audio: 'audio files' };
    return (
        <div>
            <div className="mb-3 flex flex-wrap gap-2">
                {MODES.map((x) => <Pill key={x.id} active={x.id === sel} onClick={() => setSel(x.id)}>{x.name}</Pill>)}
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span className="font-semibold uppercase tracking-wide">with model</span>
                {MODELS.map((x) => <Pill key={x.id} active={x.id === modelId} onClick={() => setModelId(x.id)}>{x.name}</Pill>)}
            </div>
            <div className="rounded-xl border border-line bg-paper-1 px-4 py-2">
                {!allowed && (
                    <div className="my-2 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs font-semibold text-warn">
                        <X size={13} className="mt-0.5 shrink-0" /> {mode.name} needs reference inputs, which {model.name} does not support. Pick a Seedance 2.x model for this mode.
                    </div>
                )}
                <Row label="What it does">{MODE_NOTES[mode.id]}</Row>
                <Row label="Prompt">{mode.requiresText ? 'Required — you must write a text prompt.' : 'Optional.'}</Row>
                <Row label="Inputs">
                    {mode.media.length === 0 ? 'None — text only.' : (
                        <ul className="list-disc space-y-1 pl-4">
                            {mode.media.map((s) => (
                                <li key={s.role}>
                                    <span className="font-semibold text-ink-2">{s.label}</span> — {s.min === 0 ? 'optional, ' : s.min === s.max ? '' : `${s.min}–`}{s.min === s.max && s.min !== 0 ? `exactly ${s.max}` : `up to ${s.max}`} {kindLabel[s.kind]}
                                </li>
                            ))}
                        </ul>
                    )}
                </Row>
                {mode.enhanceStyle && <Row label="Prompt enhancer">Your prompt is automatically restructured into the strict brief this style needs before generation.</Row>}
                {mode.silentSource && <Row label="Audio">The source carries no dialogue — audio may stay off for this mode.</Row>}
                {mode.hint && <Row label="Studio hint">{mode.hint}</Row>}
            </div>
        </div>
    );
}
