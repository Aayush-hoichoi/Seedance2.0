import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Columns2, Layers, Maximize2 } from 'lucide-react';

export const metadata = {
    title: 'Tools — loglineAI Studio',
    description: 'Post-production tools for your generated videos.',
};

const TOOLS = [
    { id: 'upscale', name: 'Upscale Video', blurb: 'AI super-resolution up to 8K with frame interpolation, denoise, and pro codecs (H.265, ProRes, FFV1).', icon: Maximize2, href: '/tools/upscale' },
    { id: 'exr', name: 'EXR Output', blurb: 'Lossless 16-bit 4:4:4 master (FFV1 MOV) for VFX and grading pipelines.', icon: Layers, href: '/tools/exr' },
    { id: 'compare', name: 'Compare Video', blurb: 'Side-by-side and wipe comparison of two takes, synced frame for frame.', icon: Columns2, href: null },
];

export default function ToolsPage() {
    return (
        <div className="min-h-screen w-full bg-app-bg px-4 py-6 text-ink sm:px-8">
            <div className="mx-auto max-w-5xl">
                <div className="mb-6 flex items-center gap-3">
                    <Link href="/seedance" title="Back to studio" className="grid h-7 w-7 place-items-center rounded-md border border-line bg-paper-2 text-ink-3 transition-colors hover:text-ink">
                        <ArrowLeft size={14} />
                    </Link>
                    <h1 className="font-display text-xl font-semibold">Tools</h1>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {TOOLS.map((t) => <ToolCard key={t.id} tool={t} />)}
                </div>
            </div>
        </div>
    );
}

function ToolCard({ tool: t }) {
    const Icon = t.icon;
    const body = (
        <>
            <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent/10 text-accent-hi"><Icon size={18} /></span>
                {t.href
                    ? <ArrowUpRight size={14} className="text-ink-3 transition-colors group-hover:text-accent-hi" />
                    : <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Coming soon</span>}
            </div>
            <div className="text-sm font-semibold">{t.name}</div>
            <p className="text-xs leading-relaxed text-ink-3">{t.blurb}</p>
        </>
    );
    const cls = 'flex flex-col gap-3 rounded-xl border border-line bg-paper-2 p-5';
    return t.href
        ? <Link href={t.href} className={`group ${cls} transition-colors hover:border-accent/50`}>{body}</Link>
        : <div aria-disabled="true" className={`${cls} opacity-60`}>{body}</div>;
}
