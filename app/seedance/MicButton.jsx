'use client';

// MicButton — dictate a prompt using the browser's built-in Web Speech API
// (Chrome / Edge / Safari; renders nothing on browsers without it). Click to
// start listening, click again to stop; each finished phrase is appended to
// the prompt via onText. Audio goes only to the browser's own recognizer —
// nothing is recorded or sent to our servers.

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import styles from './MicButton.module.css';

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
            className={`${styles.button} ${className}`}
            data-listening={listening}
        >
            <Image
                src="/assets/studio/liquid-glass-microphone.png"
                alt=""
                width={36}
                height={36}
                sizes="36px"
                draggable={false}
                className={styles.microphone}
            />
            {listening && <span aria-hidden="true" className={styles.recordingDot} />}
        </button>
    );
}
