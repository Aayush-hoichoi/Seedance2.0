import { notFound } from 'next/navigation';
import { isAdmin } from '../../lib/auth/user.js';
import AdminClient from './AdminClient.jsx';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  if (!(await isAdmin())) notFound();
  return <AdminClient />;
}
