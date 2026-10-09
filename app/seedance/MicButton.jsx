'use client';

// MicButton — dictate a prompt using the browser's built-in Web Speech API
// (Chrome / Edge / Safari; renders nothing on browsers without it). Click to
// start listening, click again to stop; each finished phrase is appended to
// the prompt via onText. Audio goes only to the browser's own recognizer —
// nothing is recorded or sent to our servers.

import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';

export default function MicButton({ onText, disabled, className = '' }) {
    // Support is detected in an effect (not at render) so SSR and the client's
    // first paint agree — otherwise Next logs a hydration mismatch.
    const [supported, setSupported] = useState(false);
    const [listening, setListening] = useState(false);
    const recRef = useRef(null);
    // Latest onText, so a handler captured at start() never appends to a
    // stale prompt while dictation keeps streaming phrases in.
    const onTextRef = useRef(onText);
    onTextRef.current = onText;

    useEffect(() => {
        setSupported(!!(window.SpeechRecognition || window.webkitSpeechRecognition));
        return () => recRef.current?.abort();
    }, []);

    if (!supported) return null;

    const toggle = () => {
        if (listening) { recRef.current?.stop(); return; }
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = false;
        rec.lang = navigator.language || 'en-US';
        rec.onresult = (e) => {
            for (let i = e.resultIndex; i < e.results.length; i += 1) {
                const phrase = e.results[i][0]?.transcript?.trim();
                if (e.results[i].isFinal && phrase) onTextRef.current(phrase);
            }
        };
        rec.onend = () => setListening(false);
        rec.onerror = () => setListening(false);
        recRef.current = rec;
        rec.start();
        setListening(true);
    };

    return (
        <button
            type="button"
            onClick={toggle}
            disabled={disabled}
            aria-pressed={listening}
            aria-label={listening ? 'Stop voice input' : 'Speak your prompt'}
            title={listening ? 'Listening — click to stop' : 'Speak your prompt'}
            className={`inline-flex shrink-0 items-center justify-center rounded-lg p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-40 ${className} ${listening ? 'text-danger' : 'text-white/50 hover:text-white'}`}
        >
            <Mic size={18} aria-hidden="true" className={listening ? 'animate-pulse motion-reduce:animate-none' : ''} />
        </button>
    );
}
