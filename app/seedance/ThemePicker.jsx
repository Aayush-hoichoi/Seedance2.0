'use client';

// Accent-theme swatches for the sidebar footer. Picking one applies it live
// (across the whole app via the shared CSS vars) and persists the choice; the
// default (violet) clears the stored override. Collapsed rail shows just the
// active swatch. Selection persists across reloads (see the init script in
// app/layout.js, which re-applies it before first paint — no flash).

import { useEffect, useState } from 'react';
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
                <span className="h-4 w-4 rounded-full ring-1 ring-line" style={{ background: cur.hex }} />
            </div>
        );
    }

    return (
        <div className="px-1.5 py-1">
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-ink-3">Theme</div>
            <div className="flex flex-wrap gap-1.5">
                {THEMES.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => pick(t)}
                        title={t.name}
                        aria-label={`${t.name} theme`}
                        aria-pressed={active === t.id}
                        className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${active === t.id ? 'ring-2 ring-ink ring-offset-2 ring-offset-paper-1' : 'ring-1 ring-line'}`}
                        style={{ background: t.hex }}
                    />
                ))}
            </div>
        </div>
    );
}
