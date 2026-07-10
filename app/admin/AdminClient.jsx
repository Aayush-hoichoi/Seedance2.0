'use client';
import { useEffect, useState, useCallback } from 'react';

export default function AdminClient() {
  const [requests, setRequests] = useState([]);
  const [usage, setUsage] = useState({ perUser: [], perUserModel: [] });
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    const [r, u] = await Promise.all([
      fetch('/api/admin/requests').then((x) => x.json()),
      fetch('/api/admin/usage').then((x) => x.json()),
    ]);
    setRequests(r.requests || []);
    setUsage({ perUser: u.perUser || [], perUserModel: u.perUserModel || [] });
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (id, action) => {
    setBusy(id);
    await fetch(`/api/admin/requests/${id}/${action}`, { method: 'POST' });
    setBusy(null);
    load();
  };

  return (
    <div className="min-h-screen bg-black text-white p-8 space-y-10">
      <section>
        <h1 className="text-xl font-semibold mb-4">Access requests</h1>
        <table className="w-full text-sm border-collapse">
          <thead className="text-white/50 text-left">
            <tr><th className="py-2">User</th><th>Model</th><th>Status</th><th>Note</th><th></th></tr>
          </thead>
          <tbody>
            {requests.map((q) => (
              <tr key={q.id} className="border-t border-white/10">
                <td className="py-2">{q.user_email}</td>
                <td>{q.model_id}</td>
                <td>{q.status}</td>
                <td className="text-white/60">{q.note || '—'}</td>
                <td className="text-right space-x-2">
                  {q.status !== 'approved' && (
                    <button disabled={busy === q.id} onClick={() => act(q.id, 'approve')}
                      className="px-3 py-1 rounded bg-primary text-black text-xs font-semibold disabled:opacity-50">Approve</button>
                  )}
                  {q.status !== 'revoked' && (
                    <button disabled={busy === q.id} onClick={() => act(q.id, 'revoke')}
                      className="px-3 py-1 rounded bg-white/10 text-xs disabled:opacity-50">Revoke</button>
                  )}
                </td>
              </tr>
            ))}
            {!requests.length && <tr><td colSpan={5} className="py-4 text-white/40">No requests yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h1 className="text-xl font-semibold mb-4">Usage &amp; cost (all-time)</h1>
        <table className="w-full text-sm border-collapse">
          <thead className="text-white/50 text-left">
            <tr><th className="py-2">User</th><th>Generations</th><th>Cost (USD)</th></tr>
          </thead>
          <tbody>
            {usage.perUser.map((u) => (
              <tr key={u.user_id} className="border-t border-white/10">
                <td className="py-2">{u.user_email}</td>
                <td>{u.generations}</td>
                <td>${Number(u.cost_usd).toFixed(2)}</td>
              </tr>
            ))}
            {!usage.perUser.length && <tr><td colSpan={3} className="py-4 text-white/40">No usage yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
