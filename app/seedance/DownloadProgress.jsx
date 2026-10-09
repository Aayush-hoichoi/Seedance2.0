'use client';

import { useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

export function useDownloadProgress() {
    const [pending, setPending] = useState(null);
    const inFlight = useRef(false);

    const runDownload = async (download, kind = 'video') => {
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(kind);
        try {
            await download();
        } finally {
            inFlight.current = false;
            setPending(null);
        }
    };

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
