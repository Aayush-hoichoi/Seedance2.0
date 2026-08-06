"use client";

import { useEffect } from "react";

export default function ConfirmDeleteDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  loading = false,
  onConfirm,
  onClose,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !loading) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, loading, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-5" role="alertdialog" aria-modal="true" aria-labelledby="confirm-delete-title">
      <button type="button" aria-label="Close confirmation" className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => { if (!loading) onClose?.(); }} />
      <div className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-[#0a0a0a] p-6 shadow-2xl">
        <h3 id="confirm-delete-title" className="text-lg font-bold text-white">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-white/50">{description}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={loading} className="rounded-xl border border-white/10 px-4 py-2.5 text-xs font-bold text-white/60 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={loading} className="rounded-xl bg-red-500 px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-red-400 disabled:cursor-wait disabled:opacity-60">
            {loading ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
