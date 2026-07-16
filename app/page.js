import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import LandingPage from './landing/LandingPage.jsx';

export default async function Home() {
  // Signed-in users skip the pitch and land in their workspace; everyone
  // else gets the public landing page with sign-in / sign-up.
  const { userId } = await auth();
  if (userId) redirect('/projects');
  return <LandingPage />;
}
