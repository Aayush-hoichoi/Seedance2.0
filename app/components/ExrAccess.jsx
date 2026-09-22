'use client';

import { useCallback, useEffect, useState } from 'react';

// Client-side view of the server-enforced EXR capability for the current
// workspace. The API remains the authority; this hook only controls the UI.
export function useExrAccess(projectId = null) {
    const [access, setAccess] = useState(null);
    const [loading, setLoading] = useState(true);
    const [requesting, setRequesting] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
            const response = await fetch(`/api/seedance/exr/access${query}`);
            const data = await response.json().catch(() => null);
            if (response.ok) setAccess(data);
            else setAccess({ projectId, status: 'locked', granted: false, error: data?.error || 'Could not load EXR access.' });
        } catch (error) {
            setAccess({ projectId, status: 'locked', granted: false, error: error.message || 'Could not load EXR access.' });
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        let alive = true;
        setAccess(null);
        setLoading(true);
        const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
        fetch(`/api/seedance/exr/access${query}`)
            .then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => null) }))
            .then(({ ok, data }) => {
                if (!alive) return;
                setAccess(ok ? data : { projectId, status: 'locked', granted: false, error: data?.error || 'Could not load EXR access.' });
            })
            .catch((error) => {
                if (alive) setAccess({ projectId, status: 'locked', granted: false, error: error.message || 'Could not load EXR access.' });
            })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [projectId]);

    const request = useCallback(async (note = null) => {
        setRequesting(true);
        try {
            const response = await fetch('/api/seedance/exr/access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId, note }),
            });
            const data = await response.json().catch(() => null);
            if (response.ok) setAccess(data);
            return { ok: response.ok, data };
        } catch (error) {
            return { ok: false, data: { error: error.message || 'Could not request EXR access.' } };
        } finally {
            setRequesting(false);
        }
    }, [projectId]);

    return { access, loading, requesting, request, refresh };
}
