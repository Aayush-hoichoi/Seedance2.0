'use client';
import { useEffect, useState, useCallback } from 'react';

export default function AdminClient() {
  const [requests, setRequests] = useState([]);
  const [usage, setUsage] = useState({ perUser: [], perUserModel: [] });
  const [users, setUsers] = useState([]);
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(null);
  const [userErr, setUserErr] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null); // two-click Remove guard

  const load = useCallback(async () => {
    const [r, u, m] = await Promise.all([
      fetch('/api/admin/requests').then((x) => x.json()),
      fetch('/api/admin/usage').then((x) => x.json()),
      fetch('/api/admin/users').then((x) => x.json()),
    ]);
    setRequests(r.requests || []);
    setUsage({ perUser: u.perUser || [], perUserModel: u.perUserModel || [] });
    setUsers(m.users || []);
    setMe(m.me || null);
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (id, action) => {
    setBusy(id);
    await fetch(`/api/admin/requests/${id}/${action}`, { method: 'POST' });
    setBusy(null);
    load();
  };

  const setRole = async (id, role) => {
    setBusy(id);
    setUserErr(null);
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) setUserErr((await res.json().catch(() => null))?.error || 'Role change failed.');
    setBusy(null);
    load();
  };

  // First click arms the button ("Confirm remove?", auto-resets); the second
  // click actually deletes the account — no browser dialogs.
  const removeUser = async (id) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      setTimeout(() => setConfirmDel((c) => (c === id ? null : c)), 4000);
      return;
    }
    setConfirmDel(null);
    setBusy(id);
    setUserErr(null);
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) setUserErr((await res.json().catch(() => null))?.error || 'Removal failed.');
    setBusy(null);
    load();
  };

  return (
    <div className="min-h-screen bg-black text-white p-8 space-y-10">
      <section>
        <h1 className="text-xl font-semibold mb-4">Users</h1>
        {userErr && <p className="mb-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-xs text-red-300">{userErr}</p>}
        <table className="w-full text-sm border-collapse">
          <thead className="text-white/50 text-left">
            <tr><th className="py-2">User</th><th>Role</th><th>Generations</th><th className="text-right">Actions</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-white/10">
                <td className="py-2">
                  <span className="font-medium">{u.name || u.email || u.id}</span>
                  {u.id === me && <span className="ml-2 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/15 text-primary">you</span>}
                  {u.email && u.name && <span className="ml-2 text-white/40 text-xs">{u.email}</span>}
                </td>
                <td>
                  {u.role === 'admin'
                    ? <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-300">admin</span>
                    : <span className="text-white/40 text-xs">member</span>}
                </td>
                <td>{u.generations}</td>
                <td className="text-right space-x-2 whitespace-nowrap">
                  {u.id !== me && (
                    <>
                      {u.role === 'admin' ? (
                        <button disabled={busy === u.id} onClick={() => setRole(u.id, null)}
                          className="px-3 py-1 rounded bg-white/10 text-xs disabled:opacity-50">Remove admin</button>
                      ) : (
                        <button disabled={busy === u.id} onClick={() => setRole(u.id, 'admin')}
                          className="px-3 py-1 rounded bg-amber-400/15 text-amber-300 text-xs font-semibold disabled:opacity-50">Make admin</button>
                      )}
                      <button disabled={busy === u.id} onClick={() => removeUser(u.id)}
                        className={`px-3 py-1 rounded text-xs font-semibold disabled:opacity-50 ${confirmDel === u.id ? 'bg-red-500 text-white' : 'bg-red-500/15 text-red-300'}`}>
                        {confirmDel === u.id ? 'Confirm remove?' : 'Remove'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!users.length && <tr><td colSpan={4} className="py-4 text-white/40">No users yet.</td></tr>}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-white/30">Removing a user deletes their account (sign-in) — their generations and usage history are kept for accounting.</p>
      </section>

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
