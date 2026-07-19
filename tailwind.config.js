/** @type {import('tailwindcss').Config} */
// Colour + type tokens mirror app/globals.css :root (see design.md).
// Channel-triple vars let Tailwind inject alpha: rgb(var(--x) / <alpha-value>).
const ch = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
        "./app/**/*.{js,ts,jsx,tsx}",
        "./components/**/*.{js,ts,jsx,tsx}",
        "./packages/studio/src/**/*.{js,jsx}",
        "./packages/Open-AI-Design-Agent/packages/design-agent/src/**/*.{js,jsx}",
        "./packages/Open-Poe-AI/packages/agents/src/**/*.{js,jsx,ts,tsx}",
        "./packages/Vibe-Workflow/packages/workflow-builder/src/**/*.{js,jsx,ts,tsx}",
    ],
    theme: {
        extend: {
            // Make every integer slash-opacity valid (bg-ok/12, border-line/8, …)
            // so token tints work regardless of which step a component picked.
            opacity: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i, (i / 100).toString()])),
            colors: {
                // primary = the violet accent (remapped from the old cyan).
                // `foreground` keys are the shadcn/ui semantic names, mapped onto
                // the SAME house tokens so vendored components inherit the theme.
                primary: { DEFAULT: ch('accent'), hover: ch('accent-hi'), ink: ch('accent-ink'), foreground: ch('accent-ink') },
                accent: { DEFAULT: ch('accent'), hi: ch('accent-hi'), ink: ch('accent-ink'), foreground: ch('accent-ink') },
                // grounds
                'app-bg': ch('paper-0'),
                'panel-bg': ch('paper-1'),
                'card-bg': ch('paper-2'),
                paper: { 0: ch('paper-0'), 1: ch('paper-1'), 2: ch('paper-2'), 3: ch('paper-3') },
                line: { DEFAULT: ch('line'), strong: ch('line-strong') },
                // text
                ink: { DEFAULT: ch('ink'), 2: ch('ink-2'), 3: ch('ink-3') },
                // shadcn/ui semantic tokens → house palette (no second theme).
                background: ch('paper-0'),
                foreground: ch('ink'),
                border: ch('line'),
                input: ch('line'),
                ring: ch('accent'),
                card: { DEFAULT: ch('paper-2'), foreground: ch('ink') },
                popover: { DEFAULT: ch('paper-1'), foreground: ch('ink') },
                secondary: { DEFAULT: ch('paper-3'), foreground: ch('ink') },
                muted: { DEFAULT: ch('paper-3'), foreground: ch('ink-3') },
                destructive: { DEFAULT: ch('danger'), foreground: ch('paper-0') },
                // semantics
                ok: ch('ok'),
                warn: ch('warn'),
                danger: ch('danger'),
            },
            fontFamily: {
                display: ['var(--font-display)', 'system-ui', 'sans-serif'],
                sans: ['var(--font-body)', 'system-ui', '-apple-system', 'sans-serif'],
                mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
            },
            borderRadius: {
                'md': 'var(--r-md)',
                'lg': 'var(--r-lg)',
                'xl': 'var(--r-xl)',
                '2xl': '1.5rem',
                '3xl': '2rem',
            },
            boxShadow: {
                '1': 'var(--shadow-1)',
                '2': 'var(--shadow-2)',
                'glow': 'var(--shadow-1)',        // legacy key, de-glowed
                'glow-accent': 'var(--shadow-1)', // legacy key, de-glowed
                '3xl': '0 35px 60px -15px rgba(0, 0, 0, 0.8)',
            }
        },
    },
    plugins: [require('tailwindcss-animate')],
}
