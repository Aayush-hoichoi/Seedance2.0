import ConsoleShell from './ConsoleShell.jsx';

export const metadata = {
    title: 'Console — loglineAI Studio',
    description: 'Access, cost and queue governance for generation models.',
};

export default function ConsoleLayout({ children }) {
    return <ConsoleShell>{children}</ConsoleShell>;
}
