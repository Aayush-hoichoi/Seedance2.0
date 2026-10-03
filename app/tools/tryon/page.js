import TryOnClient from './TryOnClient.jsx';

export const metadata = {
    title: 'Try-On — loglineAI Studio',
    description: 'Look tests & casting: attach an actor photo or create a character, drag & drop costumes — AI places them exactly, then animates.',
};

export default function TryOnPage() {
    return <TryOnClient />;
}
