'use client';

// Recharts wrappers tuned for the dark console. Imported with next/dynamic
// from pages so the chart bundle stays out of first paint.

import {
    ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
    PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, Legend,
} from 'recharts';

const PALETTE = ['#8B7CF6', '#A599F8'];
// One clearly-distinct hue per user line; 'Others' (always last) gets gray.
const LINE_PALETTE = ['#8B7CF6', '#5EEAD4', '#F59E0B', '#F472B6', '#60A5FA', '#4ADE80', '#F87171', '#FACC15', '#7C7A88'];
const AXIS = { stroke: '#7C7A88', fontSize: 11 };
const TOOLTIP_STYLE = {
    contentStyle: { background: '#1A1A21', border: '1px solid #2A2A34', borderRadius: 8, fontSize: 12 },
    labelStyle: { color: '#B4B2C0' },
    itemStyle: { color: '#F4F3F7' },
};

export function SpendArea({ data, xKey = 'key', yKey = 'cost_usd', height = 220 }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                    <linearGradient id="spend" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8B7CF6" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#8B7CF6" stopOpacity={0} />
                    </linearGradient>
                </defs>
                <CartesianGrid stroke="#2A2A34" vertical={false} />
                <XAxis dataKey={xKey} {...AXIS} tickLine={false} axisLine={false} />
                <YAxis {...AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `$${v}`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [`$${Number(v).toFixed(4)}`, 'spend']} />
                <Area type="monotone" dataKey={yKey} stroke="#8B7CF6" strokeWidth={2} fill="url(#spend)" />
            </AreaChart>
        </ResponsiveContainer>
    );
}

// One line per user (wide-format data from buildUserSpendSeries). money=false
// renders plain counts (tasks) instead of dollars. Legend shows the email's
// local part; the tooltip keeps the full email.
export function SpendLines({ data, series, xKey = 'key', height = 320, money = true }) {
    const fmt = (v) => (money ? `$${Number(v).toFixed(4)}` : Number(v).toLocaleString('en-US'));
    return (
        <ResponsiveContainer width="100%" height={height}>
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#2A2A34" vertical={false} />
                <XAxis dataKey={xKey} {...AXIS} tickLine={false} axisLine={false} />
                <YAxis {...AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => (money ? `$${v}` : v)} />
                {/* No shared itemStyle here: each tooltip row keeps its line's
                    stroke color, so users map to lines at a glance. */}
                <Tooltip contentStyle={TOOLTIP_STYLE.contentStyle} labelStyle={TOOLTIP_STYLE.labelStyle}
                    formatter={(v, n) => [fmt(v), n]}
                    itemSorter={(item) => -Number(item.value || 0)} />
                <Legend
                    wrapperStyle={{ fontSize: 11, color: '#B4B2C0' }}
                    formatter={(v) => <span style={{ color: '#B4B2C0' }}>{String(v).split('@')[0]}</span>}
                />
                {series.map((s, i) => (
                    <Line key={s} type="monotone" dataKey={s} dot={false} strokeWidth={1.8}
                        stroke={s === 'Others' ? LINE_PALETTE[LINE_PALETTE.length - 1] : LINE_PALETTE[i % (LINE_PALETTE.length - 1)]} />
                ))}
            </LineChart>
        </ResponsiveContainer>
    );
}

// Performance over time: spend (left axis, $, violet) vs tasks sent (right
// axis, count, teal), one point per day. When the lines diverge, the day's
// $/task shifted — spend climbing while tasks stay flat means pricier tasks.
export function TaskCostLines({ data, height = 280 }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#2A2A34" vertical={false} />
                <XAxis dataKey="key" {...AXIS} tickLine={false} axisLine={false} />
                <YAxis yAxisId="usd" {...AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `$${v}`} />
                <YAxis yAxisId="tasks" orientation="right" {...AXIS} tickLine={false} axisLine={false} width={40} />
                <Tooltip contentStyle={TOOLTIP_STYLE.contentStyle} labelStyle={TOOLTIP_STYLE.labelStyle}
                    formatter={(v, n) => (n === 'spend' ? [`$${Number(v).toFixed(4)}`, n] : [Number(v).toLocaleString('en-US'), n])} />
                <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => <span style={{ color: '#B4B2C0' }}>{v}</span>} />
                <Line yAxisId="usd" type="monotone" dataKey="cost_usd" name="spend" stroke="#8B7CF6" strokeWidth={2} dot={false} />
                <Line yAxisId="tasks" type="monotone" dataKey="tasks" name="tasks" stroke="#5EEAD4" strokeWidth={2} dot={false} />
            </LineChart>
        </ResponsiveContainer>
    );
}

export function SpendDonut({ data, nameKey = 'key', valueKey = 'cost_usd', height = 220 }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <PieChart>
                <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius="58%" outerRadius="85%" paddingAngle={2} stroke="none">
                    {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
                <Tooltip {...TOOLTIP_STYLE} formatter={(v, n) => [`$${Number(v).toFixed(4)}`, n]} />
            </PieChart>
        </ResponsiveContainer>
    );
}

function DetailedBarTooltip({ active, payload, label }) {
    if (!active || !payload?.length) return null;
    const total = Number(payload[0]?.value || 0);
    const rows = payload[0]?.payload?.model_breakdown ?? [];
    return (
        <div style={TOOLTIP_STYLE.contentStyle} className="min-w-64 shadow-xl">
            <div className="mb-2 text-xs text-ink-2">{label}</div>
            <div className="space-y-1.5">
                {rows.map((row) => {
                    const amount = Number(row.cost_usd || 0);
                    const pct = total > 0 ? (amount / total) * 100 : 0;
                    const tasks = Number(row.generations || 0) + Number(row.failures || 0);
                    const details = [
                        `${tasks.toLocaleString('en-US')} task${tasks === 1 ? '' : 's'}`,
                        Number(row.failures) > 0 ? `${Number(row.failures).toLocaleString('en-US')} failed` : null,
                        Number(row.images) > 0 ? `${Number(row.images).toLocaleString('en-US')} images` : null,
                        Number(row.video_seconds) > 0 ? `${Number(row.video_seconds).toLocaleString('en-US', { maximumFractionDigits: 1 })}s video` : null,
                    ].filter(Boolean);
                    return (
                        <div key={row.model_id} className="border-b border-line/60 pb-1.5 last:border-0 last:pb-0">
                            <div className="flex items-center justify-between gap-5 text-xs">
                                <span className="max-w-[13rem] truncate text-ink-2">{row.model_name || row.model_id}</span>
                                <span className="shrink-0 text-right font-mono tabular-nums text-ink">
                                    ${amount.toFixed(4)}
                                    <span className="ml-1.5 text-[10px] text-ink-3">{pct.toFixed(1)}%</span>
                                </span>
                            </div>
                            <div className="mt-0.5 text-[10px] text-ink-3">{details.join(' · ')}</div>
                        </div>
                    );
                })}
            </div>
            {!rows.length ? <div className="text-xs text-ink-3">No model spend recorded.</div> : null}
            <div className="mt-2 flex justify-between border-t border-line pt-2 text-xs">
                <span className="text-ink-3">Total spend</span>
                <span className="font-mono tabular-nums text-ink">${total.toFixed(4)}</span>
            </div>
        </div>
    );
}

export function TopBars({ data, xKey = 'key', yKey = 'cost_usd', height = 220, detailed = false }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#2A2A34" horizontal={false} />
                <XAxis type="number" {...AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
                <YAxis type="category" dataKey={xKey} {...AXIS} tickLine={false} axisLine={false} width={130}
                    tickFormatter={(v) => (String(v).length > 18 ? `${String(v).slice(0, 17)}…` : v)} />
                {detailed
                    ? <Tooltip content={<DetailedBarTooltip />} allowEscapeViewBox={{ x: true, y: true }}
                        wrapperStyle={{ zIndex: 50 }} />
                    : <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [`$${Number(v).toFixed(4)}`, 'spend']} />}
                <Bar dataKey={yKey} radius={[0, 4, 4, 0]}>
                    {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}
