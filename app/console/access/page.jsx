import { Suspense } from 'react';
import AccessClient from './AccessClient.jsx';

export const metadata = { title: 'Access — loglineAI Studio' };

// Suspense because AccessClient reads useSearchParams (?user= deep links from
// the Users page) — Next requires a boundary around that at build time.
export default function AccessPage() {
    return (
        <Suspense>
            <AccessClient />
        </Suspense>
    );
}
