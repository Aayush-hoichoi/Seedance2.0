'use client';

// Shared API-doc-style chrome for the user and admin docs pages: a sticky
// section sidebar on the left, anchored sections on the right.

import { useEffect, useState } from 'react';
import clsx from 'clsx';

export function DocShell({ title, subtitle, sections, children }) {
    const [active, setActive] = useState(sections[0]?.id);

    // Highlight the sidebar entry of the section currently in view.
    useEffect(() => {
        const obs = new IntersectionObserver(
            (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
            { rootMargin: '-10% 0px -80% 0px' },
        );
        sections.forEach((s) => {
            const el = document.getElementById(s.id);
            if (el) obs.observe(el);
        });
        return () => obs.disconnect();
    }, [sections]);

    return (
        <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6 sm:px-8">
            <nav className="sticky top-6 hidden h-fit w-52 shrink-0 self-start md:block">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-3">On this page</div>
                <ul className="space-y-0.5 border-l border-line">
                    {sections.map((s) => (
                        <li key={s.id}>
                            <a href={`#${s.id}`}
                                className={clsx('-ml-px block border-l py-1 pl-3 text-sm transition-colors',
                                    active === s.id ? 'border-accent font-semibold text-accent-hi' : 'border-transparent text-ink-3 hover:text-ink')}>
                                {s.label}
                            </a>
                        </li>
                    ))}
                </ul>
            </nav>
            <div className="min-w-0 flex-1">
                <h1 className="font-display text-3xl font-semibold tracking-wide">{title}</h1>
                {subtitle && <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed tracking-wide text-ink-3">{subtitle}</p>}
                <div className="mt-8 space-y-12">{children}</div>
            </div>
        </div>
    );
}

export function DocSection({ id, title, lead, children }) {
    return (
        <section id={id} className="scroll-mt-6">
            <h2 className="mb-1.5 font-display text-xl font-semibold tracking-wide">{title}</h2>
            {lead && <p className="mb-4 max-w-2xl text-[15px] leading-relaxed tracking-wide text-ink-3">{lead}</p>}
            {children}
        </section>
    );
}

// A plain fact table: [[term, description], …]
export function FactList({ items }) {
    return (
        <div className="rounded-xl border border-line bg-paper-1 px-4 py-1">
            {items.map(([term, desc]) => (
                <div key={term} className="grid grid-cols-[140px_1fr] gap-3 border-b border-line/60 py-2.5 text-[15px] last:border-0 sm:grid-cols-[180px_1fr]">
                    <div className="text-xs font-semibold uppercase tracking-wider text-ink-3">{term}</div>
                    <div className="leading-relaxed tracking-wide text-ink-2">{desc}</div>
                </div>
            ))}
        </div>
    );
}

export function Callout({ children }) {
    return (
        <div className="my-3 rounded-lg border border-accent/30 bg-accent/5 px-3.5 py-2.5 text-[15px] leading-relaxed tracking-wide text-ink-2">
            {children}
        </div>
    );
}
