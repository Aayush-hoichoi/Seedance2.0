import { Instrument_Serif, Inter } from 'next/font/google';
import ConsoleShell from './ConsoleShell.jsx';

// Console-only typography revamp: editorial serif display + Inter body.
// Overriding --font-display/--font-body here re-themes every heading and
// font-sans element inside the console without touching the rest of the app.
const display = Instrument_Serif({ weight: '400', subsets: ['latin'], variable: '--font-display', display: 'swap' });
const body = Inter({ subsets: ['latin'], variable: '--font-body', display: 'swap' });

export const metadata = {
    title: 'Console — loglineAI Studio',
    description: 'Access, cost and queue governance for generation models.',
};

export default function ConsoleLayout({ children }) {
    return (
        <div className={`${display.variable} ${body.variable} contents font-sans`}>
            <ConsoleShell>{children}</ConsoleShell>
        </div>
    );
}
