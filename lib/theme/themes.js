// Accent themes. Each swaps the three accent CSS vars the whole app reads
// (--accent / --accent-hi / --accent-ink); grounds and text stay the same, so
// only the accent colour changes over the dark UI. Values are sRGB channel
// triples ("r g b") to match app/globals.css (rgb(var(--accent) / <alpha>)).
// accentHi = hover (accent lightened ~18% toward white). accentInk = text on a
// filled accent surface; every swatch is light enough for near-black ink.
// 'default' is the violet baked into :root — selecting it clears the override.

export const THEMES = [
    { id: 'default', name: 'Violet', hex: '#8B7CF6', accent: '139 124 246', accentHi: '165 153 248', accentInk: '20 18 28' },
    { id: 'coral', name: 'Coral', hex: '#EF7571', accent: '239 117 113', accentHi: '242 142 139', accentInk: '20 18 28' },
    { id: 'orange', name: 'Orange', hex: '#F3AC6D', accent: '243 172 109', accentHi: '245 187 135', accentInk: '20 18 28' },
    { id: 'butter', name: 'Butter', hex: '#FADF6D', accent: '250 223 109', accentHi: '251 229 135', accentInk: '20 18 28' },
    { id: 'green', name: 'Green', hex: '#86D885', accent: '134 216 133', accentHi: '156 223 155', accentInk: '20 18 28' },
    { id: 'sky', name: 'Sky', hex: '#66A5F9', accent: '102 165 249', accentHi: '130 181 250', accentInk: '20 18 28' },
    { id: 'orchid', name: 'Orchid', hex: '#D469EE', accent: '212 105 238', accentHi: '220 132 241', accentInk: '20 18 28' },
    { id: 'pink', name: 'Pink', hex: '#F7A8C4', accent: '247 168 196', accentHi: '248 184 207', accentInk: '20 18 28' },
];

export const DEFAULT_THEME_ID = 'default';
export const THEME_STORAGE_KEY = 'seedance:theme';

export const findTheme = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
