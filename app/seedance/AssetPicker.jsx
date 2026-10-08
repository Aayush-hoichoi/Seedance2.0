'use client';

// Library picker — browse the user's private BytePlus asset groups and pick an
// existing asset to reference via asset://. Groups load per GroupType tab; assets
// load on group select. Only Active assets whose kind the current mode accepts
// are selectable.

import { useEffect, useState } from 'react';
import { GROUP_TYPES, listGroups, listAssets } from '../../lib/seedance/assetsClient.js';

const KIND_LABEL = { image: 'Image', video: 'Video', audio: 'Audio' };

function MusicGlyph() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
        </svg>
    );
}

function AssetCard({ asset, disabled, onPick }) {
    const inactive = asset.status !== 'Active';
    const blocked = disabled || inactive;
    return (
        <button
            type="button"
            disabled={blocked}
            onClick={() => onPick(asset)}
            title={blocked ? (inactive ? `Asset is ${asset.status}` : 'Not allowed in this mode') : asset.name || asset.id}
            className={`group relative aspect-square rounded-xl overflow-hidden border text-left transition-all ${
                blocked ? 'border-white/5 opacity-40 cursor-not-allowed' : 'border-white/10 hover:border-primary/50 hover:scale-[1.02]'
            }`}
        >
            {asset.kind === 'image' && asset.previewUrl ? (
                <img src={asset.previewUrl} alt={asset.name} className="w-full h-full object-cover bg-black/40" loading="lazy" />
            ) : (
                <div className="w-full h-full flex items-center justify-center bg-primary/5 text-primary/60">
                    {asset.kind === 'audio' ? <MusicGlyph /> : <span className="text-[10px] font-bold uppercase">{KIND_LABEL[asset.kind]}</span>}
                </div>
            )}
            <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-black/70 backdrop-blur-sm">
                <p className="text-[10px] text-white/80 truncate">{asset.name || asset.id}</p>
            </div>
            {inactive && (
                <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-[8px] font-bold uppercase text-amber-300">{asset.status}</span>
            )}
        </button>
    );
}

export default function AssetPicker({ allowedKinds, onPick, onClose }) {
    const [groupType, setGroupType] = useState(GROUP_TYPES[0].id);
    const [groups, setGroups] = useState([]);
    const [activeGroup, setActiveGroup] = useState(null);
    const [assets, setAssets] = useState([]);
    const [loadingGroups, setLoadingGroups] = useState(false);
    const [loadingAssets, setLoadingAssets] = useState(false);
    const [error, setError] = useState(null);

    // Load groups whenever the type tab changes.
    useEffect(() => {
        let cancelled = false;
        setLoadingGroups(true);
        setError(null);
        setActiveGroup(null);
        setAssets([]);
        listGroups(groupType)
            .then((g) => { if (!cancelled) { setGroups(g); if (g[0]) setActiveGroup(g[0]); } })
            .catch((e) => { if (!cancelled) setError(e.message); })
            .finally(() => { if (!cancelled) setLoadingGroups(false); });
        return () => { cancelled = true; };
    }, [groupType]);

    // Load assets when the selected group changes.
    useEffect(() => {
        if (!activeGroup) return undefined;
        let cancelled = false;
        setLoadingAssets(true);
        setError(null);
        listAssets(activeGroup.id, activeGroup.groupType)
            .then((a) => { if (!cancelled) setAssets(a); })
            .catch((e) => { if (!cancelled) setError(e.message); })
            .finally(() => { if (!cancelled) setLoadingAssets(false); });
        return () => { cancelled = true; };
    }, [activeGroup]);

    return (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in-up" onClick={onClose}>
            <div className="w-full max-w-4xl h-[80vh] bg-[#0a0a0a] rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
                {/* header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                    <div className="flex items-center gap-3">
                        <h2 className="text-sm font-bold text-white">Your asset library</h2>
                        <div className="flex gap-1">
                            {GROUP_TYPES.map((t) => (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => setGroupType(t.id)}
                                    className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${groupType === t.id ? 'bg-primary/15 text-primary' : 'text-white/50 hover:text-white hover:bg-white/[0.06]'}`}
                                >{t.label}</button>
                            ))}
                        </div>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-md text-white/50 hover:text-white hover:bg-white/[0.06]">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>

                {error && (
                    <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-[11px] text-red-300">{error}</div>
                )}

                <div className="flex-1 flex min-h-0">
                    {/* groups column */}
                    <div className="w-56 shrink-0 border-r border-white/[0.06] overflow-y-auto custom-scrollbar p-2">
                        {loadingGroups ? (
                            <p className="px-2 py-3 text-xs text-white/30">Loading groups…</p>
                        ) : groups.length === 0 ? (
                            <p className="px-2 py-3 text-xs text-white/30">No {groupType === 'AIGC' ? 'virtual' : 'real-human'} groups yet.</p>
                        ) : groups.map((g) => (
                            <button
                                key={g.id}
                                type="button"
                                onClick={() => setActiveGroup(g)}
                                className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors mb-0.5 ${activeGroup?.id === g.id ? 'bg-primary/15 text-primary font-semibold' : 'text-white/70 hover:bg-white/[0.06] hover:text-white'}`}
                            >
                                <span className="block truncate">{g.name}</span>
                                <span className="block truncate text-[9px] text-white/25">{g.id}</span>
                            </button>
                        ))}
                    </div>

                    {/* assets grid */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                        {loadingAssets ? (
                            <p className="text-xs text-white/30">Loading assets…</p>
                        ) : assets.length === 0 ? (
                            <p className="text-xs text-white/30">{activeGroup ? 'No assets in this group.' : 'Select a group.'}</p>
                        ) : (
                            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                                {assets.map((a) => (
                                    <AssetCard key={a.id} asset={a} disabled={!allowedKinds.includes(a.kind)} onPick={onPick} />
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="px-5 py-2 border-t border-white/[0.06] text-[10px] text-white/30">
                    Picked assets are referenced as <code className="text-white/50">asset://id</code> — no re-upload, no base64.
                </div>
            </div>
        </div>
    );
}
