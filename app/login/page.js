import { Suspense } from 'react';
import LoginForm from './LoginForm.jsx';

export const metadata = {
    title: 'Sign in · LoglineAI',
};

export default function LoginPage() {
    return (
        <main className="flex min-h-screen w-full items-center justify-center bg-[#050505] px-4">
            <Suspense fallback={null}>
                <LoginForm />
            </Suspense>
        </main>
    );
}
