'use client';

// Recharts wrappers tuned for the dark console. Imported with next/dynamic
// from pages so the chart bundle stays out of first paint.

import {
    ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
    PieChart, Pie, Cell, BarChart, Bar,
} from 'recharts';

const PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#22d3ee', '#c084fc'];
const AXIS = { stroke: '#52525b', fontSize: 11 };
const TOOLTIP_STYLE = {
    contentStyle: { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 },
    labelStyle: { color: '#a1a1aa' },
    itemStyle: { color: '#e4e4e7' },
};

export function SpendArea({ data, xKey = 'key', yKey = 'cost_usd', height = 220 }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                    <linearGradient id="spend" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                    </linearGradient>
                </defs>
                <CartesianGrid stroke="#27272a" vertical={false} />
                <XAxis dataKey={xKey} {...AXIS} tickLine={false} axisLine={false} />
                <YAxis {...AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `$${v}`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [`$${Number(v).toFixed(4)}`, 'spend']} />
                <Area type="monotone" dataKey={yKey} stroke="#38bdf8" strokeWidth={2} fill="url(#spend)" />
            </AreaChart>
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

export function TopBars({ data, xKey = 'key', yKey = 'cost_usd', height = 220 }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#27272a" horizontal={false} />
                <XAxis type="number" {...AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
                <YAxis type="category" dataKey={xKey} {...AXIS} tickLine={false} axisLine={false} width={130}
                    tickFormatter={(v) => (String(v).length > 18 ? `${String(v).slice(0, 17)}…` : v)} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [`$${Number(v).toFixed(4)}`, 'spend']} />
                <Bar dataKey={yKey} radius={[0, 4, 4, 0]}>
                    {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}
