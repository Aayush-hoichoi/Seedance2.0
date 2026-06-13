'use client';

// The large floating preview shown when hovering a media thumbnail: plays the
// video (with its own audio) or shows the image at a comfortable size, with the
// positional tag, the asset name, and the clip length. Shared by the prompt
// bar's reference thumbs and the history panel's reference list, so both look
// identical.
//
// Rendered through a portal with FIXED positioning computed from the anchor's
// screen rect — the history panel and its thumbs are both `overflow-hidden`, so
// an absolutely-positioned card would be clipped; a body portal escapes that.

import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const PREVIEW_W = 224; // matches the old w-56 card width
const GAP = 10; // px between the thumbnail and the card
const EDGE = 8; // min viewport margin so the card never touches the edge

// Seconds → "m:ss" (e.g. 8 → "0:08"); null for unknown/zero so the badge hides.
const formatDuration = (s) => {
    if (!Number.isFinite(s) || s <= 0) return null;
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

export default function MediaHoverPreview({ anchor, src, isVideo, tag, name }) {
    const [duration, setDuration] = useState(null);
    const [pos, setPos] = useState(null);

    // Track the anchor's position (and follow scroll/resize) so the card stays
    // pinned above the thumbnail, clamped within the viewport horizontally.
    useLayoutEffect(() => {
        if (!anchor) return undefined;
        const place = () => {
            const r = anchor.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const left = Math.max(EDGE, Math.min(cx - PREVIEW_W / 2, window.innerWidth - PREVIEW_W - EDGE));
            setPos({ left, bottom: window.innerHeight - r.top + GAP, caret: cx - left });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };
    }, [anchor]);

    if (!pos || typeof document === 'undefined') return null;
    const dur = formatDuration(duration);

    return createPortal(
        <div className="fixed z-[80] pointer-events-none" style={{ left: pos.left, bottom: pos.bottom, width: PREVIEW_W }}>
            <div className="rounded-xl overflow-hidden border border-primary/30 bg-[#0a0a0a] shadow-2xl shadow-black/60">
                {isVideo ? (
                    // Unmuted: the preview plays the reference's own audio (the user
                    // has already interacted with the page by hovering an asset).
                    <div className="relative">
                        <video src={src} autoPlay loop playsInline onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} className="block w-full max-h-56 object-contain bg-black" />
                        {dur && <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 bg-black/80 text-white rounded text-[10px] font-bold leading-none tabular-nums">{dur}</span>}
                    </div>
                ) : (
                    <img src={src} alt="" className="block w-full max-h-56 object-contain bg-black" />
                )}
                {(tag || name) && (
                    <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-white/[0.06]">
                        {tag && <span className="shrink-0 px-1.5 py-0.5 bg-primary text-black rounded-full text-[9px] font-black leading-none">{tag}</span>}
                        {name && <span className="truncate text-[10px] text-white/60">{name}</span>}
                    </div>
                )}
            </div>
            {/* caret pointing down at the thumbnail */}
            <div className="absolute top-full -mt-1.5 w-2.5 h-2.5 rotate-45 bg-[#0a0a0a] border-r border-b border-primary/30" style={{ left: pos.caret - 5 }} />
        </div>,
        document.body,
    );
}
