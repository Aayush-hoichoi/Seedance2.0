import ProjectDetailClient from './ProjectDetailClient.jsx';

export const metadata = { title: 'Project — loglineAI Studio' };

export default async function ProjectDetailPage({ params }) {
    const { id } = await params;
    return <ProjectDetailClient projectId={Number(id)} />;
}
