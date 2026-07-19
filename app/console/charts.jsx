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

// One spend line per user (wide-format data from buildUserSpendSeries).
// Legend shows the email's local part; the tooltip keeps the full email.
export function SpendLines({ data, series, xKey = 'key', height = 320 }) {
    return (
        <ResponsiveContainer width="100%" height={height}>
            <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#2A2A34" vertical={false} />
                <XAxis dataKey={xKey} {...AXIS} tickLine={false} axisLine={false} />
                <YAxis {...AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `$${v}`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v, n) => [`$${Number(v).toFixed(4)}`, n]} />
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
                <CartesianGrid stroke="#2A2A34" horizontal={false} />
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
