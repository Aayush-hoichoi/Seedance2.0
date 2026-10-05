import { Suspense } from 'react';
import RequestsClient from './RequestsClient.jsx';

export const metadata = { title: 'Requests — loglineAI Studio' };

// Suspense because RequestsClient reads useSearchParams (?tab= deep links
// from the Teams cards) — Next requires a boundary around that at build time.
export default function RequestsPage() {
    return (
        <Suspense>
            <RequestsClient />
        </Suspense>
    );
}
