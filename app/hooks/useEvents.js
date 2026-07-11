'use client';

// One shared EventSource per tab, fanned out to any number of subscribers.
// useEvents(type, handler) — type '*' receives everything. The browser
// auto-reconnects (server closes each stream ~4.5 min) and resumes from
// Last-Event-ID, so no events are missed across reconnects.

import { useEffect, useRef } from 'react';

const TYPES = [
    'access.granted', 'access.revoked', 'access.expired',
    'job.status_changed', 'budget.threshold_crossed',
    'project.paused', 'project.resumed',
];

let source = null;
let refs = 0;
const subscribers = new Set(); // { type, fn }

function ensureSource() {
    if (source || typeof window === 'undefined') return;
    source = new EventSource('/api/events');
    for (const type of TYPES) {
        source.addEventListener(type, (e) => {
            let data = null;
            try { data = JSON.parse(e.data); } catch { /* keepalive/malformed */ }
            for (const s of subscribers) {
                if (s.type === '*' || s.type === type) s.fn({ type, data });
            }
        });
    }
}

export function useEvents(type, handler) {
    const fnRef = useRef(handler);
    fnRef.current = handler;
    useEffect(() => {
        const sub = { type, fn: (evt) => fnRef.current?.(evt) };
        subscribers.add(sub);
        refs += 1;
        ensureSource();
        return () => {
            subscribers.delete(sub);
            refs -= 1;
            if (refs === 0 && source) { source.close(); source = null; }
        };
    }, [type]);
}
