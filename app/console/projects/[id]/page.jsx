import { Suspense } from 'react';
import ProjectDetailClient from './ProjectDetailClient.jsx';

export const metadata = { title: 'Project — loglineAI Studio' };

// Suspense: the client reads ?tab= via useSearchParams, which Next requires
// to sit under a boundary for prerendering.
export default async function ProjectDetailPage({ params }) {
    const { id } = await params;
    return (
        <Suspense>
            <ProjectDetailClient projectId={Number(id)} />
        </Suspense>
    );
}
