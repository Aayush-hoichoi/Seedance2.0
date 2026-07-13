// Shared Clerk theming + auth shell (see design.md). Keeps sign-in / sign-up
// visually consistent with the refined-dark-studio system.

export const clerkAppearance = {
    variables: {
        // colorNeutral drives Clerk's derived text/border shades — it defaults to
        // black, which is invisible on a dark ground. White flips the whole scale.
        colorNeutral: 'white',
        colorPrimary: '#8B7CF6',
        colorPrimaryForeground: '#14121C',
        colorBackground: '#1A1A21',
        // both old + new variable names so it themes across Clerk versions
        colorText: '#F4F3F7',
        colorForeground: '#F4F3F7',
        colorTextSecondary: '#B4B2C0',
        colorMutedForeground: '#B4B2C0',
        colorInputBackground: '#22222B',
        colorInput: '#22222B',
        colorInputText: '#F4F3F7',
        colorInputForeground: '#F4F3F7',
        colorDanger: '#F26D6D',
        colorSuccess: '#3FCF8E',
        borderRadius: '9px',
        fontFamily: 'var(--font-body)',
    },
    elements: {
        rootBox: 'w-full',
        card: 'bg-paper-2 border border-line-strong shadow-2',
        headerTitle: 'font-display text-ink',
        headerSubtitle: 'text-ink-3',
        socialButtonsBlockButton: 'border border-line text-ink hover:bg-paper-3',
        socialButtonsBlockButtonText: 'text-ink font-medium',
        dividerText: 'text-ink-3',
        dividerLine: 'bg-line',
        formFieldLabel: 'text-ink-2',
        formButtonPrimary: 'bg-accent hover:bg-accent-hi text-accent-ink font-semibold normal-case',
        footerActionText: 'text-ink-3',
        footerActionLink: 'text-accent-hi hover:text-accent',
        formFieldInput: 'bg-paper-3 border-line text-ink',
    },
};

export function AuthShell({ eyebrow, title, subtitle, children }) {
    return (
        <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-app-bg px-5 py-12 text-ink">
            {/* faint atmospheric wash — real CSS, not fake chrome */}
            <div aria-hidden className="pointer-events-none absolute inset-0"
                style={{ background: 'radial-gradient(60rem 40rem at 50% -10%, rgb(139 124 246 / 0.12), transparent 70%)' }} />
            <div className="relative w-full max-w-[400px]">
                <div className="mb-7 text-center">
                    <div className="mb-3 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-3">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" /> {eyebrow}
                    </div>
                    <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
                    <p className="mt-1.5 text-sm text-ink-3">{subtitle}</p>
                </div>
                <div className="flex justify-center">{children}</div>
            </div>
        </div>
    );
}
