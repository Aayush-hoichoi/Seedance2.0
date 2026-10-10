'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { LoaderCircle } from 'lucide-react';
import { downloadKeyForAsset, getDownloadProgress, runTrackedDownload, subscribeToDownload } from '../../lib/seedance/downloadProgress.mjs';

const serverSnapshot = () => null;

export function useDownloadProgress(asset) {
    const anonymousKey = useRef(null);
    if (!anonymousKey.current) anonymousKey.current = Symbol('download');
    const key = downloadKeyForAsset(asset) ?? anonymousKey.current;
    const subscribe = useCallback((listener) => subscribeToDownload(key, listener), [key]);
    const snapshot = useCallback(() => getDownloadProgress(key), [key]);
    const pending = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
    const runDownload = useCallback((download, kind = 'video') => runTrackedDownload(key, download, kind), [key]);
    return { pending, runDownload };
}

export default function DownloadProgress({ pending }) {
    if (!pending) return null;
    return (
        <div role="status" className="flex items-start gap-2.5 rounded-md border border-accent/30 bg-accent/5 px-3 py-2.5 text-ink">
            <LoaderCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin text-accent motion-reduce:animate-none" />
            <div className="min-w-0 text-xs leading-relaxed">
                <p className="font-semibold">{pending === 'video' ? 'Processing video…' : 'Preparing download…'}</p>
                <p className="text-ink-2">Your download will start automatically when ready.</p>
            </div>
        </div>
    );
}
