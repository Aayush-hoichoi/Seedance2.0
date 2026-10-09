'use client';

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';

const ITEM_CLASS = 'min-h-9 text-xs focus:bg-paper-3 focus:text-ink';
const LABEL_CLASS = 'text-[10px] font-semibold uppercase tracking-wider text-ink-2';

export default function VideoDownloadFormat({ value, onValueChange }) {
    return (
        <Select value={value} onValueChange={onValueChange}>
            <SelectTrigger
                aria-label="Download format"
                title="Video file format for Download"
                className="h-auto min-h-11 w-auto min-w-0 flex-1 gap-2 border-line bg-paper-2 px-2 py-2.5 text-xs font-semibold text-ink hover:bg-paper-3 active:bg-paper-3 sm:min-h-0"
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent
                position="popper"
                align="end"
                collisionPadding={8}
                className="z-[120] min-w-56 max-w-[calc(100vw-1rem)] border-line bg-paper-1 text-ink motion-reduce:animate-none"
                onEscapeKeyDown={(event) => event.stopPropagation()}
            >
                <SelectGroup>
                    <SelectLabel className={LABEL_CLASS}>Standard</SelectLabel>
                    <SelectItem value="mov" className={ITEM_CLASS}>.mov</SelectItem>
                    <SelectItem value="mp4" className={ITEM_CLASS}>.mp4</SelectItem>
                </SelectGroup>
                <SelectSeparator className="my-1.5 bg-line" />
                <SelectGroup>
                    <SelectLabel className={LABEL_CLASS}>ProRes · MOV</SelectLabel>
                    <SelectItem value="prores" className={ITEM_CLASS}>ProRes 4444 (10-bit)</SelectItem>
                </SelectGroup>
                <SelectSeparator className="my-1.5 bg-line" />
                <SelectGroup>
                    <SelectLabel className={LABEL_CLASS}>25 fps</SelectLabel>
                    <SelectItem value="mov25" className={ITEM_CLASS}>.mov · 25 fps</SelectItem>
                    <SelectItem value="mp425" className={ITEM_CLASS}>.mp4 · 25 fps</SelectItem>
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}
