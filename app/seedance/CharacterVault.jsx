'use client';

// The character vault drawer — hidden in normal use; the header's "Vault"
// button slides it in from the right over a blurred backdrop. All of the
// project's saved characters are listed vertically: image, name, description
// and creator. "Tag in prompt" does exactly what the "@" mention does —
// inserts @Name and attaches the stored reference image.

import { useEffect } from 'react';
import Link from 'next/link';
import { AtSign, Users, X } from 'lucide-react';

export default function CharacterVault({ characters, onTag, onClose }) {
    // Lock body scroll while open; Escape closes.
    useEffect(() => {
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = prev;
            window.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-[85] flex justify-end">
            {/* Blurred backdrop — clicking it closes the vault. */}
            <button type="button" aria-label="Close the vault" onClick={onClose}
                className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-sm" />
            <aside className="animate-slide-in-right relative flex h-full w-[22rem] max-w-[90vw] flex-col border-l border-line bg-paper-1 shadow-2xl">
                <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
                    <Users size={15} className="text-ink-2" />
                    <h2 className="text-sm font-semibold">Character vault</h2>
                    <span className="text-[11px] text-ink-3">· {characters.length}</span>
                    <div className="ml-auto flex items-center gap-2">
                        <Link href="/characters" className="text-[11px] font-semibold text-accent-hi underline-offset-2 hover:underline">Manage</Link>
                        <button type="button" onClick={onClose} aria-label="Close" title="Close"
                            className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                            <X size={13} />
                        </button>
                    </div>
                </header>
                <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    {characters.length === 0 ? (
                        <p className="pt-6 text-center text-xs leading-relaxed text-ink-3">
                            No characters saved yet.<br />
                            Create one on the <Link href="/characters" className="font-semibold text-accent-hi underline-offset-2 hover:underline">Characters page</Link> — it shows up here for the whole project.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-3">
                            {characters.map((c) => (
                                <li key={c.id} className="flex gap-3 rounded-xl border border-line bg-paper-2 p-3">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={`/api/tryon/file?key=${encodeURIComponent(c.media_key)}`} alt={c.name}
                                        className="h-20 w-20 shrink-0 rounded-lg border border-line object-cover" />
                                    <div className="flex min-w-0 flex-1 flex-col">
                                        <h3 className="truncate text-sm font-semibold" title={c.name}>{c.name}</h3>
                                        <p className="mt-0.5 line-clamp-2 flex-1 text-[11px] leading-relaxed text-ink-2" title={c.description || ''}>
                                            {c.description || <span className="italic text-ink-3">No description yet.</span>}
                                        </p>
                                        <div className="mt-1.5 flex items-center justify-between gap-2">
                                            <span className="truncate text-[10px] text-ink-3">by {c.creator_name || 'a teammate'}</span>
                                            <button type="button" onClick={() => onTag(c)}
                                                title={`Put @${c.name} in the prompt and attach the stored reference image`}
                                                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] font-semibold text-accent-hi transition-colors hover:bg-accent/20">
                                                <AtSign size={10} /> Tag in prompt
                                            </button>
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </aside>
        </div>
    );
}
