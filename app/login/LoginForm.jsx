'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

// Only allow same-origin relative redirect targets (defends against open-redirect).
function safeNext(next) {
    if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
        return next;
    }
    return '/seedance';
}

export default function LoginForm() {
    const router = useRouter();
    const params = useSearchParams();
    const next = safeNext(params.get('next'));

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    async function onSubmit(event) {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            if (res.ok) {
                router.push(next);
                router.refresh();
                return;
            }
            const data = await res.json().catch(() => ({}));
            setError(
                data.error === 'Auth not configured'
                    ? 'Login is not configured on the server.'
                    : 'Incorrect username or password.',
            );
        } catch {
            setError('Network error. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <form
            onSubmit={onSubmit}
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-8 backdrop-blur-xl"
        >
            <div className="mb-6 text-center">
                <h1 className="text-2xl font-extrabold tracking-tight text-white">
                    Logline<span className="text-[#22d3ee]">AI</span>
                </h1>
                <p className="mt-1 text-sm text-white/40">Sign in to continue</p>
            </div>

            <label className="mb-3 block">
                <span className="mb-1.5 block text-xs font-medium text-white/50">Username</span>
                <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-[#22d3ee]/60"
                    required
                />
            </label>

            <label className="mb-4 block">
                <span className="mb-1.5 block text-xs font-medium text-white/50">Password</span>
                <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-[#22d3ee]/60"
                    required
                />
            </label>

            {error && (
                <p className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {error}
                </p>
            )}

            <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-[#22d3ee] px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {busy ? 'Signing in…' : 'Sign in'}
            </button>
        </form>
    );
}
