'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { videoPreviewQueue } from '../../lib/seedance/videoPreviewQueue.mjs';

// A plain video source for Studio; Gallery supplies its archive/live player.
function PreviewVideo({ item, videoRef, onUnavailable, onError, ...videoProps }) {
    if (!item.archiveUrl) return null;
    return <video ref={videoRef} src={item.archiveUrl} {...videoProps} onError={(event) => {
        onError?.(event);
        onUnavailable?.();
    }} />;
}

function stopPreviewVideo(video) {
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load(); // abort the MP4 transfer, rather than relying on preload hints
}

// Keep a small displayed canvas after decoding one frame. Drawing is allowed
// even for cross-origin video: we never read its pixels or export the canvas.
// This avoids adding CORS requirements to otherwise playable provider links.
export default function VideoThumbnail({ item, visible, hovered = false, Player = PreviewVideo, playerProps, compact = false }) {
    const canvasRef = useRef(null);
    const videoRef = useRef(null);
    const releaseRef = useRef(null);
    const [ready, setReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [slow, setSlow] = useState(false);
    const [timedOut, setTimedOut] = useState(false);
    const [failed, setFailed] = useState(false);
    // A renewed signature retries a failed preview without discarding an
    // already captured frame of this same generation.
    useEffect(() => { setFailed(false); setTimedOut(false); }, [item.archiveUrl]);
    const attachVideo = useCallback((video) => {
        if (videoRef.current && videoRef.current !== video) stopPreviewVideo(videoRef.current);
        videoRef.current = video;
    }, []);

    useEffect(() => {
        if (!visible || ready || failed || timedOut || hovered) return;
        let slowTimer;
        let deadlineTimer;
        const cancel = videoPreviewQueue.enqueue((release) => {
            releaseRef.current = release;
            setLoading(true);
            setSlow(false);
            // Large 4K files can need a tail-metadata range before a frame.
            // Report the delay without throwing away their download progress.
            slowTimer = setTimeout(() => setSlow(true), 12000);
            deadlineTimer = setTimeout(() => {
                stopPreviewVideo(videoRef.current);
                setLoading(false);
                setTimedOut(true);
                release();
            }, 60000);
        });
        return () => {
            clearTimeout(slowTimer);
            clearTimeout(deadlineTimer);
            releaseRef.current = null;
            setLoading(false);
            cancel();
        };
    }, [visible, ready, failed, timedOut, hovered]);

    const captureFrame = (event) => {
        const video = event.currentTarget;
        if (ready || video.seeking || video.readyState < 2 || !video.videoWidth) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        try {
            const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            if (!hovered) stopPreviewVideo(video);
            setReady(true);
            setFailed(false);
            setTimedOut(false);
        } catch {
            if (!hovered) stopPreviewVideo(video);
            setFailed(true);
        }
        setLoading(false);
        releaseRef.current?.();
    };
    const unavailable = useCallback(() => {
        setFailed(true);
        setLoading(false);
        releaseRef.current?.();
    }, []);
    const state = ready ? 'ready' : failed ? 'error' : timedOut ? 'timeout' : loading || hovered ? 'loading' : visible ? 'queued' : 'idle';
    return (
        <div className="relative h-full w-full" data-preview-state={state}>
            <canvas ref={canvasRef} aria-hidden="true" className={`absolute inset-0 h-full w-full object-cover ${ready ? '' : 'invisible'}`} />
            {(hovered || (visible && loading && !ready)) && (
                <Player {...playerProps} key={hovered ? 'hover' : 'still'} item={item} videoRef={attachVideo}
                    className={`absolute inset-0 h-full w-full object-cover ${hovered ? '' : 'opacity-0 pointer-events-none'}`}
                    muted playsInline preload="metadata" autoPlay={hovered} loop={hovered}
                    onLoadedMetadata={(event) => {
                        if (!hovered && Number.isFinite(event.currentTarget.duration)) {
                            event.currentTarget.currentTime = Math.min(0.1, event.currentTarget.duration / 2);
                        }
                    }}
                    onLoadedData={captureFrame} onSeeked={captureFrame} onUnavailable={unavailable} />
            )}
            {!ready && <div role="status" className={`absolute inset-0 flex items-center justify-center font-medium text-white/65 pointer-events-none ${compact ? 'flex-col gap-1 px-2 text-center text-[9px] leading-snug' : 'gap-2 text-[11px]'}`}>
                {failed ? 'Preview unavailable · Click to play' : timedOut ? 'Preview is taking too long · Click to play' : <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />{slow ? 'Taking longer… Loading preview' : loading || hovered ? 'Loading preview…' : 'Preparing preview…'}</>}
            </div>}
        </div>
    );
}

