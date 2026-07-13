'use client';

// Floating bottom prompt-bar — matches the muapi Image/Video Studio house style:
// round media buttons + transparent auto-grow textarea on top, a row of compact
// control pills + a cyan Generate button below. Wired to the Seedance modes/options.

import { Fragment, useEffect, useRef, useState } from 'react';
import { MODES, RATIOS } from '../../lib/seedance/constants.js';
import { estimateCost } from '../../lib/seedance/pricing.mjs';
import { filterTags, tagLabelFor, tagToken, TOKEN_RE } from '../../lib/seedance/tags.js';
import MediaHoverPreview from './MediaHoverPreview.jsx';

// Render the prompt with @Image1 / @Video2 / @Audio3 tokens as cyan chips.
// Rendered in a backdrop behind a transparent-text textarea, so the chip
// styling is background-and-color ONLY (no padding/border/font-weight) — any
// property that changes glyph advance widths desyncs the painted text from
// the textarea's caret, making typed letters appear in the wrong place.
function renderChips(text, tags) {
    const known = new Set(tags.map((t) => t.label.replace(' ', '').toLowerCase()));
    const re = new RegExp(TOKEN_RE.source, 'gi');
    const out = [];
    let last = 0;
    let m;
    let i = 0;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        const valid = known.has(`${m[1].toLowerCase()}${m[2]}`);
        out.push(
            <span key={i++} className={`rounded-[4px] ${valid ? 'bg-primary/25 text-primary' : 'bg-white/10 text-white/40'}`}>
                {m[0]}
            </span>,
        );
        last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
}

// File-input accept by media kind.
const ACCEPT = { image: 'image/*', video: 'video/*', audio: 'audio/*' };

const PILL = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-all whitespace-nowrap group disabled:opacity-40';
const PILL_IDLE = 'bg-white/[0.06] hover:bg-white/[0.1] border-white/[0.1]';
const PILL_ON = 'bg-primary/10 border-primary/30';

/* ── tiny inline icons (single stroke voice, 14px) ──────────────────────── */
const ic = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 };
const Chevron = () => (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" className="opacity-50 group-hover:opacity-100 transition-opacity"><path d="M6 9l6 6 6-6" /></svg>
);
const AspectIcon = () => (<svg {...ic} className="opacity-70"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>);
const ResIcon = () => (<svg {...ic} className="opacity-70"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 12h20" /></svg>);
const ClockIcon = () => (<svg {...ic} className="opacity-70"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
const DiceIcon = () => (<svg {...ic} className="opacity-70"><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none" /></svg>);
const AudioIcon = () => (<svg {...ic} className="opacity-80"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19 5a9 9 0 010 14M15.5 8.5a4 4 0 010 7" /></svg>);
const DropIcon = () => (<svg {...ic} className="opacity-75"><path d="M12 3s6 6 6 11a6 6 0 11-12 0c0-5 6-11 6-11z" /></svg>);
const MusicIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>);
const ImageIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>);
const FilmIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5" /></svg>);

/* ── popover shell ──────────────────────────────────────────────────────── */
function Popover({ children }) {
    return (
        <div
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-[calc(100%+12px)] left-0 z-50 min-w-[170px] max-h-[min(60vh,22rem)] overflow-y-auto custom-scrollbar bg-paper-1 rounded-lg p-2 shadow-2xl border border-white/[0.05]"
        >
            {children}
        </div>
    );
}

function PillSelect({ id, openKey, setOpenKey, badge, display, label, options, value, onSelect, disabled }) {
    const open = openKey === id;
    return (
        <div className="relative">
            <button
                type="button"
                disabled={disabled}
                onClick={(e) => { e.stopPropagation(); setOpenKey(open ? null : id); }}
                className={`${PILL} ${open ? PILL_ON : PILL_IDLE}`}
            >
                {badge}
                <span className={`text-xs font-semibold transition-colors ${open ? 'text-primary' : 'text-white/90 group-hover:text-primary'}`}>{display}</span>
                <Chevron />
            </button>
            {open && (
                <Popover>
                    {label && <div className="px-2 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-white/50">{label}</div>}
                    <div className="flex flex-col gap-0.5">
                        {options.map((opt) => (
                            <button
                                key={String(opt.value)}
                                type="button"
                                onClick={() => { onSelect(opt.value); setOpenKey(null); }}
                                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${opt.value === value ? 'bg-primary/15 text-primary font-semibold' : 'text-white/70 hover:bg-white/[0.06] hover:text-white'}`}
                            >{opt.label}</button>
                        ))}
                    </div>
                </Popover>
            )}
        </div>
    );
}

function PillToggle({ label, active, onToggle, disabled, icon }) {
    return (
        <button type="button" disabled={disabled} onClick={onToggle} className={`${PILL} ${active ? PILL_ON : PILL_IDLE}`}>
            <span className={active ? 'text-primary' : 'text-white/65'}>{icon}</span>
            <span className={`text-xs font-semibold transition-colors ${active ? 'text-primary' : 'text-white/90 group-hover:text-primary'}`}>{label}</span>
        </button>
    );
}

// Duration as a slider + number box (matches the ModelArk playground):
// integer 4–15 s, or Auto (-1) to let the model decide.
function DurationControl({ openKey, setOpenKey, duration, setDuration }) {
    const open = openKey === 'dur';
    const isAuto = duration === -1;
    const [text, setText] = useState(isAuto ? '' : String(duration));
    useEffect(() => { setText(isAuto ? '' : String(duration)); }, [duration, isAuto]);

    const commit = () => {
        const n = Number(text);
        if (text !== '' && Number.isFinite(n)) setDuration(Math.max(4, Math.min(15, Math.round(n))));
        else setText(isAuto ? '' : String(duration));
    };

    return (
        <div className="relative">
            <button type="button" onClick={(e) => { e.stopPropagation(); setOpenKey(open ? null : 'dur'); }} className={`${PILL} ${open ? PILL_ON : PILL_IDLE}`}>
                <span className={open ? 'text-primary' : 'text-white/65'}><ClockIcon /></span>
                <span className={`text-xs font-semibold ${open ? 'text-primary' : 'text-white/90 group-hover:text-primary'}`}>{isAuto ? 'Auto' : `${duration}s`}</span>
                <Chevron />
            </button>
            {open && (
                <Popover>
                    <div className="px-2 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-white/50">Duration · 4–15s</div>
                    <div className="flex items-center gap-3 w-72 px-2 pb-1.5">
                        <input
                            type="range"
                            min={4}
                            max={15}
                            step={1}
                            value={isAuto ? 5 : duration}
                            onChange={(e) => setDuration(Number(e.target.value))}
                            className="flex-1 h-1 accent-primary cursor-pointer"
                        />
                        <div className="flex items-center gap-1 shrink-0 bg-black/40 border border-white/10 rounded-md px-2 py-1.5 focus-within:border-primary/50">
                            <input
                                type="number"
                                min={4}
                                max={15}
                                value={text}
                                placeholder="–"
                                onChange={(e) => setText(e.target.value)}
                                onBlur={commit}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
                                className="w-8 bg-transparent text-xs text-white text-center outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                            <span className="text-[10px] text-white/40">s</span>
                        </div>
                        <button type="button" onClick={() => setDuration(-1)} className={`shrink-0 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${isAuto ? 'bg-primary/15 text-primary' : 'bg-white/[0.06] text-white/60 hover:text-primary'}`}>Auto</button>
                    </div>
                </Popover>
            )}
        </div>
    );
}

function SeedControl({ openKey, setOpenKey, seed, setSeed, disabled }) {
    const open = openKey === 'seed';
    const ref = useRef(null);
    const isRandom = String(seed) === '-1' || seed === -1;
    return (
        <div className="relative">
            <button type="button" disabled={disabled} onClick={(e) => { e.stopPropagation(); setOpenKey(open ? null : 'seed'); }} className={`${PILL} ${open ? PILL_ON : PILL_IDLE}`}>
                <span className={open ? 'text-primary' : 'text-white/65'}><DiceIcon /></span>
                <span className={`text-xs font-semibold ${open ? 'text-primary' : 'text-white/90 group-hover:text-primary'}`}>{isRandom ? 'Seed' : `Seed · ${seed}`}</span>
            </button>
            {open && (
                <Popover>
                    <div className="px-2 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-white/50">Seed</div>
                    <div className="flex gap-2 w-56 px-1 pb-1">
                        <input
                            ref={ref}
                            type="number"
                            defaultValue={seed}
                            onChange={(e) => setSeed(e.target.value)}
                            className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded-md px-2.5 py-1.5 text-xs text-white focus:border-primary/50 outline-none"
                        />
                        <button type="button" onClick={() => { setSeed(-1); if (ref.current) ref.current.value = '-1'; }} className="shrink-0 px-2.5 py-1.5 rounded-md bg-white/[0.06] text-white/70 text-xs font-semibold hover:text-primary transition-colors">Random</button>
                    </div>
                </Popover>
            )}
        </div>
    );
}

/* ── inline media (round buttons + thumbnails) ──────────────────────────── */
function Thumb({ item, badge, tag, onRemove }) {
    const [hover, setHover] = useState(false);
    const thumbRef = useRef(null); // anchor for the floating hover preview
    const closeTimer = useRef(null);
    // Keep the preview open while the cursor is on the thumb OR the preview, so
    // its download button stays reachable across the gap between them.
    const showPreview = () => { clearTimeout(closeTimer.current); setHover(true); };
    const hidePreview = () => { closeTimer.current = setTimeout(() => setHover(false), 140); };
    // Library assets carry a signed previewUrl (the reference url is asset://id,
    // which a browser can't render). Uploads carry a base64 data url in `url`.
    // Only browser-loadable schemes qualify — a missing/expired preview (e.g.
    // refs reused from old history) falls back to the kind icon, never a
    // broken <img src="asset://…">.
    const imgSrc = [item.previewUrl, item.url].find((u) => typeof u === 'string' && /^(https?:|data:|blob:)/i.test(u)) || null;
    // Only image/video previews are worth blowing up on hover; an audio data
    // url also matches the scheme test above but can't render in <img>/<video>.
    const isVid = item.kind === 'video';
    const canPreview = !!imgSrc && (item.isImage || item.kind === 'image' || isVid);
    // A URL being registered into the library — show progress until Active.
    if (item.pending) {
        return (
            <div className="relative w-10 h-10 shrink-0" title={`${item.status || 'Registering'}… ${item.name || ''}`}>
                <div className="w-full h-full rounded-full border border-primary/40 bg-primary/5 flex items-center justify-center text-primary">
                    <span className="animate-spin inline-block text-sm">◌</span>
                </div>
                <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 px-1.5 py-0.5 bg-black/80 text-primary rounded-full text-[8px] font-bold leading-none whitespace-nowrap pointer-events-none">{item.status || '…'}</span>
                <button type="button" onClick={onRemove} aria-label="Cancel" className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black border border-white/20 text-white/70 text-[10px] leading-none hover:text-white hover:border-white/40 flex items-center justify-center">×</button>
            </div>
        );
    }
    return (
        <div
            ref={thumbRef}
            className="relative w-10 h-10 shrink-0"
            onMouseEnter={showPreview}
            onMouseLeave={hidePreview}
        >
            {/* Hover preview: a larger floating card so you can actually see the
                attached reference without leaving the prompt bar. Mounted only
                while hovered, so a video only loads/plays on demand. */}
            {hover && canPreview && (
                <MediaHoverPreview anchor={thumbRef.current} src={imgSrc} isVideo={isVid} tag={tag} name={item.name} onMouseEnter={showPreview} onMouseLeave={hidePreview} />
            )}
            {item.isImage && imgSrc ? (
                <img src={imgSrc} alt="" className="w-full h-full object-cover rounded-full border border-primary/40" />
            ) : item.kind === 'video' && imgSrc ? (
                <video src={imgSrc} muted playsInline preload="metadata" title={item.name} className="w-full h-full object-cover rounded-full border border-primary/40 bg-black" />
            ) : (
                <div className="w-full h-full rounded-full border border-primary/40 bg-primary/5 flex items-center justify-center text-primary" title={item.name}>
                    {item.kind === 'video' ? <FilmIcon /> : item.kind === 'audio' ? <MusicIcon /> : <ImageIcon />}
                </div>
            )}
            {item.fromLibrary && <span className="absolute -bottom-0.5 -left-0.5 w-3.5 h-3.5 bg-primary rounded-full border border-black flex items-center justify-center" title="From your asset library"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3"><path d="M4 7h16M4 12h16M4 17h10" /></svg></span>}
            {tag && <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 px-1.5 py-0.5 bg-primary text-black rounded-full text-[8px] font-black leading-none whitespace-nowrap pointer-events-none shadow-lg" title={`Reference as "${tag}" in your prompt`}>{tag}</span>}
            {badge && <span className="absolute top-0 left-0 px-1 h-3.5 bg-black/70 rounded-md text-[7px] font-black text-primary leading-none flex items-center justify-center pointer-events-none">{badge}</span>}
            <button type="button" onClick={onRemove} aria-label="Remove" className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black border border-white/20 text-white/70 text-[10px] leading-none hover:text-white hover:border-white/40 flex items-center justify-center">×</button>
        </div>
    );
}

// Thumbnails for every attached reference + ONE "+" button that accepts
// image/video/audio together (like the ModelArk playground); the studio routes
// each picked file to the right slot by MIME type.
function MediaButtons({ mode, mediaByRole, setMediaByRole, disabled, onUploadFiles, tags }) {
    const inputRef = useRef(null);
    const removeAt = (role, i) => setMediaByRole({ ...mediaByRole, [role]: (mediaByRole[role] || []).filter((_, idx) => idx !== i) });

    if (!mode.media.length) return null;

    const kinds = [...new Set(mode.media.map((s) => s.kind))];
    const accept = kinds.map((k) => ACCEPT[k]).join(',');
    const totalMax = mode.media.reduce((t, s) => t + s.max, 0);
    const anyRoom = mode.media.some((s) => (mediaByRole[s.role] || []).length < s.max);

    return (
        <div className="flex items-center gap-2 flex-wrap shrink-0">
            {mode.media.map((slot) => {
                const items = mediaByRole[slot.role] || [];
                const badge = slot.role === 'last_frame' ? 'END' : null;
                return (
                    <Fragment key={slot.role}>
                        {items.map((it, i) => <Thumb key={i} item={it} badge={badge} tag={tagLabelFor(tags || [], slot.role, i)} onRemove={() => removeAt(slot.role, i)} />)}
                    </Fragment>
                );
            })}
            {anyRoom && (
                <>
                    <input ref={inputRef} type="file" hidden accept={accept} multiple={totalMax > 1} onChange={(e) => { onUploadFiles?.(e.target.files); e.target.value = ''; }} />
                    <button
                        type="button"
                        disabled={disabled}
                        title={`Add ${kinds.join(' / ')} from your computer → your asset library`}
                        onClick={() => inputRef.current?.click()}
                        className="w-10 h-10 shrink-0 rounded-full border bg-white/[0.03] border-white/[0.08] border-dashed hover:bg-white/10 hover:border-primary/50 flex items-center justify-center text-white/50 hover:text-primary transition-all disabled:opacity-40"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    </button>
                </>
            )}
        </div>
    );
}

/* ── the bar ────────────────────────────────────────────────────────────── */
const BATCH_OPTIONS = [1, 2 /* , 4 — capped at ×2 for now; uncomment to bring ×4 back */];

export default function PromptBar({
    mode, onChangeMode, prompt, onPromptChange, options, setOpt,
    mediaByRole, setMediaByRole, models, allowedModelIds, resolutions, selectedModel,
    error, notice, setNotice, onGenerate, enhancing = false, batch = 1, setBatch,
    onMediaError, onUploadFiles, tags,
}) {
    const [openKey, setOpenKey] = useState(null);
    const [mention, setMention] = useState(null); // { start, query } while typing "@…"
    const [mentionIdx, setMentionIdx] = useState(0); // keyboard-highlighted menu row
    const [docked, setDocked] = useState(false); // slim strip while scrolled away from the page bottom
    const taRef = useRef(null);
    const chipRef = useRef(null); // chip backdrop, scroll-synced with the textarea
    const manualResizedRef = useRef(false); // true once the user drags the resize grip — stops auto-grow fighting it
    const allTagsPossible = mode.media.some((s) => s.role.startsWith('reference_'));

    // ModelArk-console behavior: scrolling up through the page shrinks the bar
    // to a slim strip; reaching the bottom again restores the full bar. Driven
    // purely by scroll/resize events so a page that never scrolls never docks,
    // and never docks mid-typing (focused textarea) or with an error showing.
    useEffect(() => {
        const onScroll = () => {
            const doc = document.documentElement;
            const fromBottom = doc.scrollHeight - window.innerHeight - window.scrollY;
            const scrollable = doc.scrollHeight > window.innerHeight + 40;
            const typing = document.activeElement === taRef.current;
            setDocked(scrollable && fromBottom > 100 && !typing && !error);
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll, { passive: true });
        onScroll();
        return () => {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
        };
    }, [error]);

    const undock = () => {
        setDocked(false);
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    };

    // Close any open popover on an outside click. Pills/popovers stop propagation.
    useEffect(() => {
        if (!openKey) return undefined;
        const close = () => setOpenKey(null);
        document.addEventListener('click', close);
        return () => document.removeEventListener('click', close);
    }, [openKey]);

    // Auto-grow up to a comfortable cap; once the user has manually dragged the
    // resize grip we leave the height alone (CSS max-height bounds the drag).
    const autoGrow = (el) => { if (!el || manualResizedRef.current) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; };

    // Re-fit the box to its content whenever the prompt is set programmatically
    // (e.g. "Reuse" loads a long prompt) or the bar re-expands from its docked
    // pill. Without this the textarea stays one line tall and a reused prompt is
    // clipped — autoGrow otherwise only fires on keystrokes. A cleared prompt
    // re-enables auto-grow so a fresh prompt isn't stuck at a manual height.
    useEffect(() => {
        if (!prompt) manualResizedRef.current = false;
        autoGrow(taRef.current);
    }, [prompt, docked]);

    // @-mention: typing "@" after whitespace opens a menu of the attached assets'
    // positional tags (Image 1, Video 1, …). Selecting one inserts the literal
    // "Image 1" text BytePlus expects in the prompt.
    const allTags = tags || [];
    const mentionTags = mention ? filterTags(allTags, mention.query) : [];
    const showMention = !!mention && mentionTags.length > 0;

    const detectMention = (el) => {
        const pos = el.selectionStart ?? el.value.length;
        const m = /(?:^|\s)@(\w*)$/.exec(el.value.slice(0, pos));
        if (m && allTags.length) setMention({ start: pos - m[1].length - 1, query: m[1] });
        else setMention(null);
        setMentionIdx(0); // re-typing re-filters; highlight returns to the top row
    };

    const onPromptInput = (e) => { onPromptChange(e.target.value); autoGrow(e.target); detectMention(e.target); };

    const insertTag = (tag) => {
        const el = taRef.current;
        const pos = el?.selectionStart ?? prompt.length;
        const start = mention ? mention.start : pos;
        const token = tagToken(tag); // "@Image1"
        const next = `${prompt.slice(0, start)}${token} ${prompt.slice(pos)}`;
        onPromptChange(next);
        setMention(null);
        requestAnimationFrame(() => {
            if (!el) return;
            const caret = start + token.length + 1;
            el.focus();
            el.setSelectionRange(caret, caret);
            autoGrow(el);
        });
    };

    // Docked: a slim pill that previews the prompt; clicking it scrolls back to
    // the bottom and the full bar re-expands (the parent keeps prompt/media
    // state, so nothing is lost across the swap).
    if (docked) {
        const attached = mode.media.reduce((n, s) => n + (mediaByRole[s.role] || []).length, 0);
        return (
            <div className="fixed bottom-4 inset-x-0 mx-auto w-[95%] max-w-xl z-40 animate-fade-in-up">
                <button
                    type="button"
                    onClick={undock}
                    title="Back to the prompt bar"
                    className="w-full bg-paper-1/80 backdrop-blur-3xl rounded-full border border-white/10 pl-4 pr-3 py-2.5 flex items-center gap-3 shadow-2xl text-left hover:border-primary/40 transition-colors group"
                >
                    <span className="w-4 h-4 shrink-0 bg-primary rounded flex items-center justify-center"><span className="text-[9px] font-bold text-black">S</span></span>
                    <span className={`flex-1 min-w-0 truncate text-sm ${prompt ? 'text-white/80' : 'text-white/40'}`}>
                        {prompt || 'Describe the video…'}
                    </span>
                    {attached > 0 && (
                        <span className="shrink-0 px-2 py-0.5 rounded-full bg-primary/15 text-primary text-[10px] font-bold">{attached} ref{attached > 1 ? 's' : ''}</span>
                    )}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-white/40 group-hover:text-primary transition-colors"><path d="M6 15l6-6 6 6" /></svg>
                </button>
            </div>
        );
    }

    return (
        <div className="fixed bottom-4 inset-x-0 mx-auto w-[95%] max-w-4xl z-40 animate-fade-in-up" style={{ animationDelay: '0.15s' }}>
            <div className="w-full bg-paper-1/80 backdrop-blur-3xl rounded-2xl border border-white/10 p-4 flex flex-col gap-2 shadow-2xl">
                {/* media + prompt */}
                <div className="relative flex items-start gap-2 px-1">
                    {showMention && (
                        <div className="absolute bottom-full left-0 mb-2 z-50 min-w-[190px] max-h-60 overflow-y-auto custom-scrollbar bg-paper-1 rounded-lg p-1.5 shadow-2xl border border-white/[0.08]">
                            <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-white/50">Reference an asset</div>
                            {mentionTags.map((t, i) => {
                                const active = i === Math.min(mentionIdx, mentionTags.length - 1);
                                return (
                                    <button
                                        key={t.label}
                                        type="button"
                                        onMouseDown={(e) => { e.preventDefault(); insertTag(t); }}
                                        onMouseEnter={() => setMentionIdx(i)}
                                        className={`w-full text-left px-2.5 py-1.5 rounded-md text-sm flex items-center justify-between gap-3 transition-colors ${active ? 'bg-primary/15 text-primary' : 'text-white/80'}`}
                                    >
                                        <span className="font-semibold">{tagToken(t)}</span>
                                        {t.name && <span className="text-[10px] text-white/30 truncate max-w-[100px]">{t.name}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <MediaButtons mode={mode} mediaByRole={mediaByRole} setMediaByRole={setMediaByRole} onUploadFiles={onUploadFiles} tags={allTags} />
                    {/* Chip-rendered prompt: a backdrop paints the text (tokens as
                        cyan chips) behind a transparent-text textarea, so editing
                        mechanics stay native while @Image1 reads as a pill. */}
                    <div className="relative flex-1 min-w-0">
                        {/* The backdrop must wrap at EXACTLY the textarea's width:
                            both scroll (synced) and both always reserve the 4px
                            scrollbar gutter, else long prompts wrap differently
                            per layer and the caret drifts off the painted text. */}
                        <div
                            ref={chipRef}
                            aria-hidden
                            className="pointer-events-none absolute inset-0 text-sm pt-2 leading-relaxed whitespace-pre-wrap break-words overflow-y-auto custom-scrollbar [scrollbar-gutter:stable] text-white"
                        >
                            {renderChips(prompt, allTags)}
                        </div>
                        <textarea
                            ref={taRef}
                            value={prompt}
                            onChange={onPromptInput}
                            onScroll={(e) => { if (chipRef.current) chipRef.current.scrollTop = e.target.scrollTop; }}
                            onKeyDown={(e) => {
                                // While the @ menu is open the keyboard drives it
                                // (like the real studio): ↑/↓ move the highlight,
                                // Enter/Tab insert it, Esc closes; caret untouched.
                                if (showMention) {
                                    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionTags.length); return; }
                                    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionTags.length) % mentionTags.length); return; }
                                    if (e.key === 'Enter' || e.key === 'Tab') {
                                        e.preventDefault();
                                        insertTag(mentionTags[Math.min(mentionIdx, mentionTags.length - 1)]);
                                        return;
                                    }
                                }
                                if (e.key === 'Escape' && mention) { e.stopPropagation(); setMention(null); }
                            }}
                            onBlur={() => setTimeout(() => setMention(null), 120)}
                            onMouseDown={(e) => {
                                // Grabbing the bottom-right resize grip flips into manual
                                // sizing so auto-grow stops snapping the height back.
                                const r = e.currentTarget.getBoundingClientRect();
                                if (e.clientX >= r.right - 18 && e.clientY >= r.bottom - 18) manualResizedRef.current = true;
                            }}
                            placeholder={allTagsPossible ? 'Describe the video — type “@” to reference an upload (e.g. actions in @Video1, character from @Image1)' : mode.requiresText ? 'Describe the video you want to create' : 'Describe the video (optional)…'}
                            rows={1}
                            title="Drag the bottom-right corner to resize"
                            className="relative block w-full bg-transparent border-none text-transparent caret-white text-sm placeholder:text-white/40 focus:outline-none resize-y pt-2 leading-relaxed min-h-[40px] max-h-[60vh] overflow-y-auto custom-scrollbar [scrollbar-gutter:stable]"
                        />
                    </div>
                </div>

                {/* error (red) / notice (amber) — descriptive hint line was removed to declutter the bar */}
                {error && (
                    <div className="mx-1 px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/20 text-[11px] text-danger">{error}</div>
                )}
                {!error && notice && (
                    <div className="mx-1 px-3 py-1.5 rounded-lg bg-warn/10 border border-warn/20 text-[11px] text-warn">{notice}</div>
                )}

                {/* controls (selectors left, toggles right) + generate (own row, right) */}
                <div className="flex flex-col gap-2 pt-2 border-t border-white/[0.03]">
                    <div className="flex items-center justify-between gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <PillSelect
                            id="mode" openKey={openKey} setOpenKey={setOpenKey}                            badge={<span className="w-4 h-4 bg-primary rounded flex items-center justify-center shadow-lg shadow-primary/10"><span className="text-[9px] font-bold text-black">S</span></span>}
                            display={mode.name} label="Mode" value={mode.id}
                            options={MODES.map((m) => ({ value: m.id, label: m.name }))} onSelect={onChangeMode}
                        />
                        <PillSelect
                            id="model" openKey={openKey} setOpenKey={setOpenKey}                            display={selectedModel?.name || 'Model'} label="Model" value={options.model}
                            options={models.map((m) => {
                                const locked = m.gated && allowedModelIds && !allowedModelIds.includes(m.id);
                                return { value: m.id, label: locked ? `${m.name} 🔒 (request access)` : m.name, disabled: locked };
                            })}
                            onSelect={(v) => {
                                const m = models.find((x) => x.id === v);
                                const locked = m?.gated && allowedModelIds && !allowedModelIds.includes(v);
                                if (locked) {
                                    fetch('/api/access/request', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ modelId: v }),
                                    })
                                        .then(async (r) => {
                                            const d = await r.json().catch(() => null);
                                            if (!r.ok) { setNotice?.(d?.error || 'Could not send the access request — try again.'); return; }
                                            setNotice?.(d?.status === 'approved'
                                                ? 'You already have access — reload the page to unlock this model.'
                                                : 'Access requested — pending admin approval.');
                                        })
                                        .catch(() => setNotice?.('Could not send the access request — check your connection.'));
                                    return;
                                }
                                setOpt('model', v);
                            }}
                        />
                        <PillSelect
                            id="ar" openKey={openKey} setOpenKey={setOpenKey}                            badge={<AspectIcon />} display={options.ratio} label="Aspect Ratio" value={options.ratio}
                            options={RATIOS.map((r) => ({ value: r, label: r }))} onSelect={(v) => setOpt('ratio', v)}
                        />
                        <PillSelect
                            id="res" openKey={openKey} setOpenKey={setOpenKey}                            badge={<ResIcon />} display={options.resolution} label="Resolution" value={options.resolution}
                            options={resolutions.map((r) => ({ value: r, label: r }))} onSelect={(v) => setOpt('resolution', v)}
                        />
                        <DurationControl openKey={openKey} setOpenKey={setOpenKey} duration={options.duration} setDuration={(v) => setOpt('duration', v)} />
                        <SeedControl openKey={openKey} setOpenKey={setOpenKey} seed={options.seed} setSeed={(v) => setOpt('seed', v)} />
                    </div>
                    <div className="flex items-center gap-1.5">
                        <PillToggle label="Audio" active={!!options.generate_audio} onToggle={() => setOpt('generate_audio', !options.generate_audio)} icon={<AudioIcon />} />
                        <PillToggle label="Watermark" active={!!options.watermark} onToggle={() => setOpt('watermark', !options.watermark)} icon={<DropIcon />} />
                    </div>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                        {/* Cost transparency: the same estimate the gateway reserves against. */}
                        {(() => {
                            const est = estimateCost({ kind: selectedModel?.kind, resolution: options.resolution, duration: options.duration });
                            return est != null ? (
                                <span className="hidden sm:inline text-[11px] font-semibold tabular-nums text-white/35 pr-1" title="Estimated cost (final cost uses real token usage)">
                                    ≈ ${(est * (batch || 1)).toFixed(2)}
                                </span>
                            ) : null;
                        })()}
                        {/* Batch: fire 1 / 2 / 4 parallel generations per click */}
                        {setBatch && (
                            <div className="flex items-center shrink-0 self-stretch rounded-md border border-white/[0.06] overflow-hidden" title="How many generations to start per click">
                                {BATCH_OPTIONS.map((n) => (
                                    <button
                                        key={n}
                                        type="button"
                                        onClick={() => setBatch(n)}
                                        className={`h-full px-3 text-xs font-bold transition-colors ${batch === n ? 'bg-primary/15 text-primary' : 'text-white/65 hover:text-white hover:bg-white/[0.08]'}`}
                                    >×{n}</button>
                                ))}
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={onGenerate}
                            disabled={enhancing}
                            className="bg-primary text-accent-ink px-5 py-2.5 rounded-md font-semibold text-sm hover:bg-accent-hi transition-colors flex items-center justify-center gap-2 w-full sm:w-auto disabled:opacity-60"
                        >
                            {enhancing ? (
                                <><span className="animate-spin inline-block">◌</span> Structuring prompt…</>
                            ) : (
                                batch > 1 ? `Generate ×${batch}` : 'Generate'
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
