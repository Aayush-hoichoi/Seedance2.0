'use client';

// Client-only helpers to apply + persist the accent theme. The initial paint is
// handled by a blocking inline script in app/layout.js (no flash); these run on
// user interaction and to read the current choice for the picker UI.

import { DEFAULT_THEME_ID, THEME_STORAGE_KEY, findTheme } from './themes.js';

// Set (or clear, for default) the accent vars on <html> so the change is live.
export function applyThemeVars(theme) {
    if (typeof document === 'undefined') return;
    const s = document.documentElement.style;
    if (!theme || theme.id === DEFAULT_THEME_ID) {
        s.removeProperty('--accent');
        s.removeProperty('--accent-hi');
        s.removeProperty('--accent-ink');
        return;
    }
    s.setProperty('--accent', theme.accent);
    s.setProperty('--accent-hi', theme.accentHi);
    s.setProperty('--accent-ink', theme.accentInk);
}

// Persist only a non-default choice (default falls back to the :root vars).
export function saveTheme(theme) {
    try {
        if (!theme || theme.id === DEFAULT_THEME_ID) localStorage.removeItem(THEME_STORAGE_KEY);
        else localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
            id: theme.id, accent: theme.accent, accentHi: theme.accentHi, accentInk: theme.accentInk,
        }));
    } catch { /* private mode / storage disabled */ }
}

export function loadThemeId() {
    try {
        const raw = localStorage.getItem(THEME_STORAGE_KEY);
        return raw ? findTheme(JSON.parse(raw).id).id : DEFAULT_THEME_ID;
    } catch { return DEFAULT_THEME_ID; }
}
