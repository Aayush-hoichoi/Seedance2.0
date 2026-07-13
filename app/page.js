import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/projects'); // land on the project list — the studio is entered through a project
}
