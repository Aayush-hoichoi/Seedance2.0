import TryOnClient from './TryOnClient.jsx';

export const metadata = {
    title: 'Try-On — loglineAI Studio',
    description: 'Drag & drop an asset onto a character — AI dresses them, then animates the result.',
};

export default function TryOnPage() {
    return <TryOnClient />;
}
