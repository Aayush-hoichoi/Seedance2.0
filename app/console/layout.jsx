import ConsoleShell from './ConsoleShell.jsx';

export const metadata = {
    title: 'Console — Model Gateway',
    description: 'Access, cost and queue governance for generation models.',
};

export default function ConsoleLayout({ children }) {
    return <ConsoleShell>{children}</ConsoleShell>;
}
