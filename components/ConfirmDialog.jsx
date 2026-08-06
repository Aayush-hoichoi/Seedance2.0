'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export default function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel = 'Delete',
    onConfirm,
    loading = false,
}) {
    const changeOpen = (nextOpen) => {
        if (!loading) onOpenChange?.(nextOpen);
    };

    return (
        <Dialog open={open} onOpenChange={changeOpen}>
            <DialogContent overlayClassName="z-[200]" className="z-[200] w-[min(92vw,440px)] rounded-xl border-line bg-paper-1 p-5 sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle className="font-display text-base font-semibold text-ink">{title}</DialogTitle>
                    <DialogDescription className="pt-1 text-sm leading-relaxed text-ink-2">{description}</DialogDescription>
                </DialogHeader>
                <DialogFooter className="mt-2 gap-2 sm:gap-2">
                    <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={loading}>Cancel</Button>
                    <Button type="button" variant="destructive" onClick={onConfirm} disabled={loading} className="gap-1.5">
                        {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                        {confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
