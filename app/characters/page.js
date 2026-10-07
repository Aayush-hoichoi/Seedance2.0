import CharactersClient from './CharactersClient.jsx';

export const metadata = {
    title: 'Characters — loglineAI Studio',
    description: 'The project’s shared cast: create, describe and reuse characters across every generation for continuity.',
};

export default function CharactersPage() {
    return <CharactersClient />;
}
