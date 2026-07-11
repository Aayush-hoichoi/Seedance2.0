import ProjectDetailClient from './ProjectDetailClient.jsx';

export const metadata = { title: 'Project — Model Gateway' };

export default async function ProjectDetailPage({ params }) {
    const { id } = await params;
    return <ProjectDetailClient projectId={Number(id)} />;
}
