'use client';

// Accent-theme swatches for the sidebar footer. Picking one applies it live
// (across the whole app via the shared CSS vars) and persists the choice; the
// default (violet) clears the stored override. Collapsed rail shows just the
// active swatch. Selection persists across reloads (see the init script in
// app/layout.js, which re-applies it before first paint — no flash).

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { THEMES, DEFAULT_THEME_ID, findTheme } from '../../lib/theme/themes.js';
import { applyThemeVars, saveTheme, loadThemeId } from '../../lib/theme/themeClient.js';

export default function ThemePicker({ collapsed = false }) {
    const [active, setActive] = useState(DEFAULT_THEME_ID);

    // Read the persisted choice after mount (the init script already applied the
    // colours; this just syncs the highlighted swatch).
    useEffect(() => { setActive(loadThemeId()); }, []);

    const pick = (theme) => {
        setActive(theme.id);
        applyThemeVars(theme);
        saveTheme(theme);
    };

    if (collapsed) {
        const cur = findTheme(active);
        return (
            <div className="flex justify-center py-1" title={`Theme: ${cur.name}`}>
                <span className="h-5 w-5 rounded-full ring-1 ring-line" style={{ background: cur.hex }} />
            </div>
        );
    }

    return (
        <div className="px-1.5 py-1">
            <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Theme</span>
                <span className="text-[11px] font-medium text-ink-2">{findTheme(active).name}</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
                {THEMES.map((t) => {
                    const on = active === t.id;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => pick(t)}
                            title={t.name}
                            aria-label={`${t.name} theme`}
                            aria-pressed={on}
                            className={`grid aspect-square w-full place-items-center rounded-lg outline-none transition-all hover:scale-105 focus-visible:ring-2 focus-visible:ring-ink ${on ? 'ring-2 ring-ink ring-offset-2 ring-offset-paper-1' : 'ring-1 ring-white/15 hover:ring-white/40'}`}
                            style={{ background: t.hex }}
                        >
                            {on && <Check size={14} strokeWidth={3} className="text-black/70" />}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
