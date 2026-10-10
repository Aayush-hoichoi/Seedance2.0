'use client';

import { useRef, useState, useEffect } from 'react';

export default function RecoveryPanel() {
    const [running, setRunning] = useState(false);
    const [report, setReport] = useState(null);
    const [error, setError] = useState('');
    const stop = useRef(false);
    useEffect(() => () => { stop.current = true; }, []);

    async function post(body) {
        const res = await fetch('/api/admin/recovery', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Recovery could not continue.');
        return data;
    }

    async function recover() {
        stop.current = false;
        setRunning(true);
        setError('');
        setReport(null);
        try {
            const start = await post({ action: 'start' });
            let progress = { restored: start.restored, total: start.total, checked: 0, files: 0, issues: [], done: false };
            setReport(progress);
            let before = start.before;
            while (!stop.current && before) {
                const batch = await post({ action: 'scan', before });
                progress = {
                    ...progress, checked: progress.checked + batch.outcomes.length,
                    files: progress.files + batch.outcomes.reduce((sum, item) => sum + item.recovered, 0),
                    issues: [...progress.issues, ...batch.outcomes.filter(item => item.problems.length)], done: batch.done,
                };
                setReport(progress);
                if (batch.done) break;
                // Don't repeat a credentials failure thousands of times.
                if (batch.outcomes.some(item => item.problems.some(message => /Storage check failed|credentials are not configured/.test(message)))) {
                    throw new Error('File checks stopped because storage access failed. Fix storage credentials or permissions and retry. Bin restores are saved.');
                }
                before = batch.before;
            }
        } catch (e) { setError(e.message); }
        finally { setRunning(false); }
    }

    return <section className="rounded-xl border border-line p-4 space-y-3" aria-label="Generation recovery">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
                <h2 className="font-semibold text-ink">Restore generations</h2>
                <p className="text-sm text-ink-3">Restore every creator’s Bin items and check saved images and videos across all projects.</p>
            </div>
            <button type="button" disabled={running} onClick={recover} className="rounded-lg bg-ink px-4 py-2 text-paper-1 disabled:opacity-50">
                {running ? 'Recovering…' : 'Restore and recover all'}
            </button>
            {running && <button type="button" onClick={() => { stop.current = true; }} className="text-sm underline">Stop after current batch</button>}
        </div>
        <p className="text-xs text-ink-3">Keep this page open while checking files. Recovery uses existing copies and does not generate new content. Files with no usable source cannot be restored. Older records without a generation job and enhanced outputs are not checked.</p>
        {report && <div role="status" className="text-sm space-y-2">
            <p>{report.restored} restored from Bin · {report.checked} of {report.total} generations checked · {report.files} files recovered · {report.issues.length} need attention.</p>
            {!running && <p>{report.done ? 'Recovery check complete.' : 'File check stopped before completion. Completed restores are saved.'}</p>}
            {!!report.issues.length && <details><summary className="cursor-pointer">See items needing attention</summary>
                <ul className="max-h-60 overflow-auto space-y-1 mt-2">{report.issues.map(item => <li key={item.id}>Generation #{item.id}: {item.problems.join(' ')}</li>)}</ul>
            </details>}
        </div>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </section>;
}
