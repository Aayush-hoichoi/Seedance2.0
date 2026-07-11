import { redirect } from 'next/navigation';

// The admin panel grew into the full governance console (/console) — this
// route survives only so old links keep working.
export default function AdminPage() {
    redirect('/console');
}
