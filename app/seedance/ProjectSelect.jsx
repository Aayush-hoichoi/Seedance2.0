'use client';

import * as Select from '@radix-ui/react-select';
import { ChevronDown, Check } from 'lucide-react';
import { usd } from '../../lib/seedance/money.mjs';

// shadcn-style project switcher (Radix Select) — replaces the native <select>
// so the dropdown matches the studio's dark token system on every OS instead
// of rendering the browser's default menu.
//
// The chip also carries the project's spend. `spent_usd` rides along on
// /api/projects already, so this costs no extra request: it is the WHOLE
// project's total, every member, all time — the same number the Projects page
// and the console show, deliberately, so the two can't disagree. That is a
// different thing from the budget badge beside it, which tracks what is left of
// the signed-in user's own cap.
export default function ProjectSelect({ projects, value, onChange, block }) {
    const selected = projects.find((p) => String(p.id) === String(value));
    return (
        <Select.Root value={value != null ? String(value) : undefined} onValueChange={(v) => onChange(Number(v))}>
            <Select.Trigger
                title="Project — model access and budgets are scoped per project"
                className={`inline-flex min-w-0 max-w-[40vw] items-center gap-1.5 overflow-hidden rounded-md border border-line bg-paper-3 px-2.5 py-1.5 text-xs font-semibold text-ink-2 outline-none transition-colors hover:border-line-strong hover:text-ink focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:border-accent sm:max-w-none ${block ? 'w-full justify-between' : ''}`}
            >
                {/* Children override Radix's default (the selected ItemText) so
                    the spend can sit beside the name. Falls through to the
                    placeholder while projects are still loading. */}
                <Select.Value placeholder="Project" className="min-w-0 truncate">
                    {selected ? (
                        <span className="inline-flex min-w-0 items-baseline gap-1.5 truncate">
                            {selected.name}
                            <span className="font-mono text-[11px] font-semibold tabular-nums text-ink-3">
                                {usd(selected.spent_usd)}
                            </span>
                        </span>
                    ) : null}
                </Select.Value>
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
                                className="relative flex cursor-pointer select-none items-center justify-between gap-6 rounded-[5px] py-1.5 pl-7 pr-3 text-xs font-medium text-ink-2 outline-none data-[highlighted]:bg-paper-3 data-[highlighted]:text-ink data-[state=checked]:text-ink"
                            >
                                <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                    <Check size={13} className="text-accent" />
                                </Select.ItemIndicator>
                                <Select.ItemText>{p.name}</Select.ItemText>
                                {/* Outside ItemText on purpose: ItemText is what
                                    Radix would clone into the trigger, and the
                                    trigger renders its own layout above. */}
                                <span className="font-mono text-[11px] font-semibold tabular-nums text-ink-3">
                                    {usd(p.spent_usd)}
                                </span>
                            </Select.Item>
                        ))}
                    </Select.Viewport>
                </Select.Content>
            </Select.Portal>
        </Select.Root>
    );
}
