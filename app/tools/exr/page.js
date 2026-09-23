import ExrToolClient from './ExrToolClient.jsx';

export const metadata = {
    title: 'EXR Output — loglineAI Studio',
    description: 'Generate a lossless 16-bit master from any video.',
};

export default function ExrToolPage() {
    return <ExrToolClient />;
}
