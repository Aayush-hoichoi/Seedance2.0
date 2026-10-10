import GalleryClient from './GalleryClient.jsx';

export const metadata = {
    title: 'Community Gallery — loglineAI Studio',
    description: 'Browse every creator’s generations, watch their videos, and reuse any setup in the studio.',
};

export default async function GalleryPage({ searchParams }) {
    const params = await searchParams;
    return <GalleryClient projectWideId={params?.project || ''} initialView={params?.view || 'creators'} />;
}
