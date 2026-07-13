'use client';

import * as Select from '@radix-ui/react-select';
import { ChevronDown, Check } from 'lucide-react';

// shadcn-style project switcher (Radix Select) — replaces the native <select>
// so the dropdown matches the studio's dark token system on every OS instead
// of rendering the browser's default menu.
export default function ProjectSelect({ projects, value, onChange, block }) {
    return (
        <Select.Root value={value != null ? String(value) : undefined} onValueChange={(v) => onChange(Number(v))}>
            <Select.Trigger
                title="Project — model access and budgets are scoped per project"
                className={`inline-flex items-center gap-1.5 rounded-md border border-line bg-paper-3 px-2.5 py-1.5 text-xs font-semibold text-ink-2 outline-none transition-colors hover:border-line-strong hover:text-ink focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:border-accent ${block ? 'w-full justify-between' : ''}`}
            >
                <Select.Value placeholder="Project" />
                <Select.Icon><ChevronDown size={13} className="text-ink-3" /></Select.Icon>
            </Select.Trigger>
            <Select.Portal>
                <Select.Content
                    position="popper"
                    sideOffset={6}
                    className="z-50 min-w-[9rem] overflow-hidden rounded-md border border-line bg-paper-1 p-1 shadow-2 animate-fade-in-up"
                >
                    <Select.Viewport>
                        {projects.map((p) => (
                            <Select.Item
                                key={p.id}
                                value={String(p.id)}
                                className="relative flex cursor-pointer select-none items-center rounded-[5px] py-1.5 pl-7 pr-3 text-xs font-medium text-ink-2 outline-none data-[highlighted]:bg-paper-3 data-[highlighted]:text-ink data-[state=checked]:text-ink"
                            >
                                <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                    <Check size={13} className="text-accent" />
                                </Select.ItemIndicator>
                                <Select.ItemText>{p.name}</Select.ItemText>
                            </Select.Item>
                        ))}
                    </Select.Viewport>
                </Select.Content>
            </Select.Portal>
        </Select.Root>
    );
}
