import { redirect } from 'next/navigation';

// Try-On moved into the Characters tab (/characters) — the tool is now part of
// the project-cast workflow rather than a standalone tools entry. The old URL
// lives in bookmarks, notifications and console copy, so it redirects forever.
export default function TryOnPage() {
    redirect('/characters');
}
