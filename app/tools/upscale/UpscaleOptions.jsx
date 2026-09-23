'use client';

import {
    UPSCALE_VERSIONS, UPSCALE_SCENES, UPSCALE_STYLES, UPSCALE_RESOLUTIONS,
    UPSCALE_BITRATE_LEVELS, UPSCALE_CODECS, UPSCALE_LIMITS as L, bitrateApplies, proTier, targetBitrateMbps,
} from '../../../lib/byteplus/upscaleOptions.mjs';

// Every user-facing field of the MediaKit enhance-video API. Plumbing fields
// (callback_url, callback_args, client_token, queue_id) are intentionally absent.
export default function UpscaleOptions({ value, onChange, sourceSeconds }) {
    const set = (patch) => onChange({ ...value, ...patch });
    const pro = value.version === 'professional';
    const codec = UPSCALE_CODECS.find((c) => c.value === value.codec) || UPSCALE_CODECS[0];
    const pickCodec = (c) => {
        const next = UPSCALE_CODECS.find((x) => x.value === c);
        set({ codec: c, bitDepth: next.depths.includes(value.bitDepth) ? value.bitDepth : next.depths[0] });
    };
    const tooLongFor16 = Number(sourceSeconds) > L.maxSeconds16Bit;

    return (
        <div className="flex flex-col gap-5">
            <Field label="Version" hint={[UPSCALE_VERSIONS.find((v) => v.value === value.version)?.hint, proTier(value) && `Tier: ${proTier(value)}`].filter(Boolean).join(' · ')}>
                <Segmented value={value.version} onChange={(v) => set({ version: v })} options={UPSCALE_VERSIONS} />
            </Field>

            <Field label="Scene" hint="Preset enhancement template for the kind of footage.">
                <select value={value.scene} onChange={(e) => set({ scene: e.target.value })} className={inputCls}>
                    {UPSCALE_SCENES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
            </Field>

            <Field label="Style">
                <Segmented value={value.style} onChange={(v) => set({ style: v })} options={UPSCALE_STYLES} />
            </Field>

            <Field label="Output resolution">
                <Segmented
                    value={value.resolutionMode}
                    onChange={(v) => set({ resolutionMode: v })}
                    options={[{ value: 'preset', label: 'Preset' }, { value: 'limit', label: 'Short side (px)' }, { value: 'source', label: 'Keep source' }]}
                />
                {value.resolutionMode === 'preset' && (
                    <Segmented value={value.resolution} onChange={(v) => set({ resolution: v })} options={UPSCALE_RESOLUTIONS.map((r) => ({ value: r, label: r.toUpperCase() }))} wrap />
                )}
                {value.resolutionMode === 'limit' && (
                    <NumberInput value={value.shortSide} min={L.shortSideMin} max={L.shortSideMax} suffix="px" onChange={(n) => set({ shortSide: n })}
                        hint={`Short side locked to this value, aspect ratio kept (${L.shortSideMin}–${L.shortSideMax}).`} />
                )}
            </Field>

            <Field label="Frame rate">
                <Segmented value={value.fpsMode} onChange={(v) => set({ fpsMode: v })}
                    options={[{ value: 'source', label: 'Keep source' }, { value: 'custom', label: 'Custom' }]} />
                {value.fpsMode === 'custom' && (
                    <NumberInput value={value.fps} min={L.fpsMin} max={L.fpsMax} step={0.001} decimals={3} suffix="fps" onChange={(n) => set({ fps: n })}
                        hint="Decimals allowed (23.976, 29.97). Above the source rate triggers AI frame interpolation — keep it within 4× the original." />
                )}
            </Field>

            {pro && (
                <div className="flex flex-col gap-5 rounded-lg border border-line bg-paper-3/40 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Professional output</div>
                    <Field label="Codec">
                        <select value={value.codec} onChange={(e) => pickCodec(e.target.value)} className={inputCls}>
                            {UPSCALE_CODECS.map((c) => <option key={c.value} value={c.value}>{c.label} · .{c.container}</option>)}
                        </select>
                    </Field>
                    <Field label="Bit depth" hint={value.bitDepth === 16 ? `16-bit: source must be ${L.maxSeconds16Bit}s or shorter; jobs run one at a time.` : null}>
                        <Segmented
                            value={value.bitDepth}
                            onChange={(v) => set({ bitDepth: v })}
                            options={codec.depths.map((d) => ({ value: d, label: `${d}-bit`, disabled: d === 16 && tooLongFor16 }))}
                        />
                    </Field>
                </div>
            )}

            <Field label="Bitrate" hint={bitrateApplies(value) ? null : 'Set automatically for lossless / 16-bit output.'}>
                <fieldset disabled={!bitrateApplies(value)} className="flex flex-col gap-2 disabled:opacity-40">
                    <Segmented value={value.bitrateMode} onChange={(v) => set({ bitrateMode: v })}
                        options={[{ value: 'level', label: 'Level' }, { value: 'kbps', label: 'Exact kbps' }]} />
                    {value.bitrateMode === 'level'
                        ? <>
                            <Segmented value={value.bitrateLevel} onChange={(v) => set({ bitrateLevel: v })} options={UPSCALE_BITRATE_LEVELS.map((b) => {
                                const mbps = targetBitrateMbps(value, b);
                                return { value: b, label: `${b[0].toUpperCase() + b.slice(1)}${mbps != null ? ` · ${mbps} Mbps` : ''}` };
                            })} />
                            <div className="text-[11px] leading-relaxed text-ink-3">
                                {targetBitrateMbps(value) != null
                                    ? 'Target rate; actual output lands at 0.8–1.5× depending on content.'
                                    : 'Mbps targets show once a preset resolution (not 6K) and a custom frame rate are set.'}
                            </div>
                        </>
                        : <NumberInput value={value.kbps} min={L.kbpsMin} max={L.kbpsMax} suffix="kbps" onChange={(n) => set({ kbps: n })} />}
                </fieldset>
            </Field>
        </div>
    );
}

const inputCls = 'w-full rounded-md border border-line bg-paper-3 px-2.5 py-1.5 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent';

function Field({ label, hint, children }) {
    return (
        <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold text-ink-2">{label}</div>
            {children}
            {hint && <div className="text-[11px] leading-relaxed text-ink-3">{hint}</div>}
        </div>
    );
}

function Segmented({ value, onChange, options, wrap }) {
    return (
        <div role="radiogroup" className={`flex gap-1 ${wrap ? 'flex-wrap' : ''}`}>
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={value === o.value}
                    disabled={o.disabled}
                    onClick={() => onChange(o.value)}
                    className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${value === o.value
                        ? 'border-accent/60 bg-accent/15 text-accent-hi'
                        : 'border-line bg-paper-3 text-ink-2 hover:text-ink'}`}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function NumberInput({ value, min, max, step = 1, decimals = 0, suffix, onChange, hint }) {
    const n = Number(value);
    const scale = 10 ** decimals;
    const bad = value === '' || !Number.isFinite(n) || n < min || n > max || Math.round(n * scale) !== n * scale;
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                <input type="number" inputMode={decimals ? 'decimal' : 'numeric'} min={min} max={max} step={step} value={value}
                    onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
                    aria-invalid={bad}
                    className={`${inputCls} max-w-[10rem] ${bad ? 'border-danger/60' : ''}`} />
                <span className="text-xs text-ink-3">{suffix}</span>
            </div>
            {bad && <div className="text-[11px] text-danger">{decimals ? `${min}–${max}, up to ${decimals} decimals.` : `Whole number from ${min} to ${max}.`}</div>}
            {hint && !bad && <div className="text-[11px] leading-relaxed text-ink-3">{hint}</div>}
        </div>
    );
}
