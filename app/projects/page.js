import ProjectsClient from './ProjectsClient.jsx';

export const metadata = {
    title: 'Projects — Seedance 2.0 Studio',
    description: 'Pick a project to create in — spend, members and model access are scoped per project.',
};

export default function ProjectsPage() {
    return <ProjectsClient />;
}
