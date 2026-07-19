// Pivot day_user rollup rows ({key: day, series: user, cost_usd}) into the
// wide shape Recharts wants: one object per day with a numeric field per user.
// Top N users by total spend keep their own line; the rest fold into 'Others'
// so the chart stays readable. Missing days are zero-filled so lines don't gap.

export const OTHERS = 'Others';

export function buildUserSpendSeries(rows, topN = 8) {
    const list = Array.isArray(rows) ? rows : [];
    const totals = list.reduce((acc, r) => ({
        ...acc, [r.series]: (acc[r.series] || 0) + Number(r.cost_usd || 0),
    }), {});
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const top = ranked.slice(0, topN);
    const series = ranked.length > top.length ? [...top, OTHERS] : top;

    const byDay = list.reduce((acc, r) => {
        const name = top.includes(r.series) ? r.series : OTHERS;
        const day = acc[r.key] || {};
        return { ...acc, [r.key]: { ...day, [name]: (day[name] || 0) + Number(r.cost_usd || 0) } };
    }, {});
    const data = Object.keys(byDay).sort().map((day) => ({
        key: day,
        ...Object.fromEntries(series.map((s) => [s, byDay[day][s] || 0])),
    }));
    return { data, series };
}
