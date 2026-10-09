'use client';

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { Card } from '../ui.jsx';
import { fmtInt } from '../lib.js';

const AXIS = { stroke: '#7C7A88', fontSize: 11 };
const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function duration(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    const rounded = Math.round(seconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const rest = rounded % 60;
    return hours ? `${hours}h ${minutes}m ${rest}s` : minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

function DurationTooltip({ active, payload, bucketSeconds }) {
    const point = payload?.[0]?.payload;
    if (!active || !point?.completed) return null;
    const start = DATE_TIME.format(point.timestamp);
    const end = TIME.format(point.timestamp + bucketSeconds * 1000);
    return (
        <div className="max-w-80 rounded-lg border border-line bg-[#15151B] px-3 py-2.5 text-xs shadow-xl">
            <div className="mb-2 text-ink-2">{bucketSeconds === 86400 ? `${DATE.format(point.timestamp)} IST` : `${start}–${end} IST`}</div>
            <div className="space-y-1">
                <div className="flex justify-between gap-5 text-ink-2"><span>Completed videos</span><span className="font-mono tabular-nums text-ink">{fmtInt(point.completed)}</span></div>
                <div className="flex justify-between gap-5 text-[#8B7CF6]"><span>Average</span><span className="font-mono tabular-nums">{duration(point.averageMinutes * 60)}</span></div>
                <div className="flex justify-between gap-5 text-[#F59E0B]"><span>Peak</span><span className="font-mono tabular-nums">{duration(point.peakMinutes * 60)}</span></div>
            </div>
            {point.peakModel || point.peakProvider ? (
                <div className="mt-2 border-t border-line pt-2 text-ink-3">
                    Peak: {[point.peakModel, point.peakProvider].filter(Boolean).join(' · ')}
                    {point.peakTask ? <div className="mt-1 break-all font-mono text-[10px]">{point.peakTask}</div> : null}
                </div>
            ) : null}
        </div>
    );
}

export default function GenerationDurationChart({ data }) {
    const { series = [], summary = {}, bucketSeconds = 900 } = data ?? {};
    const interval = bucketSeconds === 900 ? '15-minute' : bucketSeconds === 3600 ? 'Hourly' : 'Daily';
    const sameDay = series.length && DATE.format(series[0].timestamp) === DATE.format(series.at(-1).timestamp);
    const tick = (value) => bucketSeconds === 86400 ? DAY.format(value) : sameDay ? TIME.format(value) : `${DAY.format(value)} ${TIME.format(value)}`;

    return (
        <Card>
            <div className="mb-5">
                <h3 className="text-sm font-medium text-ink-2">Video generation time</h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-3">
                    Submission to recorded completion, including waiting, generation and saving. Successful videos across all matching results.
                </p>
            </div>
            {summary.completed ? (
                <>
                    <dl className="mb-5 grid grid-cols-3 gap-3">
                        <div><dt className="text-[11px] text-ink-3">Average time</dt><dd className="mt-1 font-mono text-base tabular-nums text-ink sm:text-xl">{duration(summary.averageSeconds)}</dd></div>
                        <div><dt className="text-[11px] text-ink-3">Peak time</dt><dd className="mt-1 font-mono text-base tabular-nums text-[#F59E0B] sm:text-xl">{duration(summary.peakSeconds)}</dd></div>
                        <div><dt className="text-[11px] text-ink-3">Completed videos</dt><dd className="mt-1 font-mono text-base tabular-nums text-ink sm:text-xl">{fmtInt(summary.completed)}</dd></div>
                    </dl>
                    <div className="mb-2 text-[11px] text-ink-3">{interval} intervals by submission time · IST · minutes</div>
                    <div role="img" aria-label={`Video generation time: average ${duration(summary.averageSeconds)}, peak ${duration(summary.peakSeconds)}, across ${fmtInt(summary.completed)} completed videos.`}>
                        <ResponsiveContainer width="100%" height={280}>
                            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                                <CartesianGrid stroke="#2A2A34" vertical={false} />
                                <XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin', 'dataMax']} {...AXIS} tickLine={false} axisLine={false} minTickGap={40} tickFormatter={tick} />
                                <YAxis {...AXIS} tickLine={false} axisLine={false} width={52} domain={[0, 'auto']} tickFormatter={(value) => `${value}m`} />
                                <Tooltip content={<DurationTooltip bucketSeconds={bucketSeconds} />} wrapperStyle={{ zIndex: 50, outline: 'none' }} />
                                <Legend wrapperStyle={{ fontSize: 11 }} formatter={(value) => <span style={{ color: '#B4B2C0' }}>{value}</span>} />
                                <Line type="linear" dataKey="averageMinutes" name="Average" stroke="#8B7CF6" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} isAnimationActive={false} />
                                <Line type="linear" dataKey="peakMinutes" name="Peak" stroke="#F59E0B" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 2 }} activeDot={{ r: 4 }} isAnimationActive={false} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                    <p className="mt-3 text-xs leading-relaxed text-ink-3">
                        Filter by model and date to inspect spikes. Video length, resolution and provider waiting can change these times; this is not isolated provider render time.
                    </p>
                </>
            ) : (
                <div className="rounded border border-dashed border-line px-4 py-8 text-center">
                    <p className="text-sm text-ink-2">No completed video timings in this view</p>
                    <p className="mt-1 text-xs text-ink-3">Choose videos or adjust the filters. Successful tasks need both submission and completion timestamps.</p>
                </div>
            )}
        </Card>
    );
}
