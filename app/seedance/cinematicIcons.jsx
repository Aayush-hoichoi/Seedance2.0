'use client';

// Custom SVG glyphs for the Cinematic Cameras panel tiles (Higgsfield-style
// layout, our own art — CSP-safe, no external assets). The aperture iris is
// live: its opening widens at low f-stops and closes down at high ones, on a
// logarithmic scale so the change reads like a real lens.

const APERTURE_MIN = 1.4;
const APERTURE_MAX = 22;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// f-stop → 0..1 (0 = wide open, 1 = stopped down), log-spaced like real stops.
function stopFraction(aperture) {
    const a = clamp(Number(aperture) || 4, APERTURE_MIN, APERTURE_MAX);
    return (Math.log(a) - Math.log(APERTURE_MIN)) / (Math.log(APERTURE_MAX) - Math.log(APERTURE_MIN));
}

// Six-blade iris. Wide at f/1.4, nearly shut at f/22. The opening is a hexagon
// (hexagonal bokeh) punched out of the metal barrel via an evenodd path.
export function ApertureIris({ aperture = 4, size = 60 }) {
    const R = 44, cx = 50, cy = 50, N = 6, swirl = 0.4;
    const openR = (0.82 - 0.68 * stopFraction(aperture)) * R;

    const hex = Array.from({ length: N }, (_, i) => {
        const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
        return [cx + openR * Math.cos(ang), cy + openR * Math.sin(ang)];
    });

    // Metal = outer circle with the hexagon subtracted (evenodd).
    const outer = `M ${cx - R} ${cy} A ${R} ${R} 0 1 0 ${cx + R} ${cy} A ${R} ${R} 0 1 0 ${cx - R} ${cy} Z`;
    const hole = `M ${hex.map((p) => p.join(' ')).join(' L ')} Z`;

    // Blade seams: a tangential line from each hexagon vertex to the barrel.
    const seams = hex.map(([x, y]) => {
        const ang = Math.atan2(y - cy, x - cx) + swirl;
        return `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(cx + R * Math.cos(ang)).toFixed(1)} ${(cy + R * Math.sin(ang)).toFixed(1)}`;
    });

    return (
        <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
            <defs>
                <radialGradient id="iris-metal" cx="38%" cy="34%" r="75%">
                    <stop offset="0%" stopColor="#4a4a55" />
                    <stop offset="60%" stopColor="#2a2a30" />
                    <stop offset="100%" stopColor="#141418" />
                </radialGradient>
                <radialGradient id="iris-light" cx="50%" cy="50%" r="55%">
                    <stop offset="0%" stopColor="#fff7e8" />
                    <stop offset="55%" stopColor="#d9a066" />
                    <stop offset="100%" stopColor="#7a4a24" />
                </radialGradient>
            </defs>
            {/* light coming through the opening */}
            <circle cx={cx} cy={cy} r={R} fill="url(#iris-light)" />
            {/* metal barrel with hexagon punched out */}
            <path d={`${outer} ${hole}`} fillRule="evenodd" fill="url(#iris-metal)" />
            {/* blade seams (dark) + a faint sheen */}
            {seams.map((d, i) => (
                <path key={i} d={d} stroke="rgba(0,0,0,0.55)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
            ))}
            {hex.map(([x, y], i) => (
                <path key={`s${i}`} d={`M ${x} ${y} L ${cx + R * Math.cos(Math.atan2(y - cy, x - cx) + swirl)} ${cy + R * Math.sin(Math.atan2(y - cy, x - cx) + swirl)}`}
                    stroke="rgba(255,255,255,0.10)" strokeWidth="0.8" fill="none" />
            ))}
            <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" />
        </svg>
    );
}

// A cine/film camera vs a boxy mirrorless, chosen by `type`.
export function CameraGlyph({ type = 'digital', size = 58 }) {
    const film = type === 'film';
    return (
        <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true"
            stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
            {/* body */}
            <rect x="16" y="40" width="52" height="34" rx="4" fill="rgba(255,255,255,0.06)" />
            {/* lens */}
            <circle cx="76" cy="57" r="11" fill="rgba(255,255,255,0.04)" />
            <circle cx="76" cy="57" r="5" fill="currentColor" opacity="0.35" />
            {/* viewfinder / top */}
            <path d="M28 40 l6 -10 h16 l6 10" fill="rgba(255,255,255,0.06)" />
            {film ? (
                <>
                    {/* film reels */}
                    <circle cx="32" cy="26" r="12" fill="rgba(255,255,255,0.05)" />
                    <circle cx="56" cy="26" r="12" fill="rgba(255,255,255,0.05)" />
                    <circle cx="32" cy="26" r="3" fill="currentColor" opacity="0.4" />
                    <circle cx="56" cy="26" r="3" fill="currentColor" opacity="0.4" />
                </>
            ) : (
                <rect x="22" y="46" width="10" height="7" rx="1.5" fill="currentColor" opacity="0.3" />
            )}
        </svg>
    );
}

// A prime lens; anamorphic gets a horizontal streak, spherical stays clean.
export function LensGlyph({ type = 'spherical', size = 58 }) {
    const ana = type === 'anamorphic';
    return (
        <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true"
            stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
            {/* barrel */}
            <rect x="18" y="34" width="64" height="32" rx="6" fill="rgba(255,255,255,0.06)" />
            {/* focus rings */}
            <path d="M34 34 v32 M46 34 v32 M58 34 v32" stroke="currentColor" strokeWidth="2" opacity="0.35" />
            {/* front element */}
            <ellipse cx="82" cy="50" rx="7" ry="16" fill="rgba(255,255,255,0.05)" />
            <ellipse cx="82" cy="50" rx="3.5" ry="9" fill={ana ? '#5aa9ff' : 'currentColor'} opacity={ana ? 0.55 : 0.3} />
            {ana && <path d="M74 50 h16" stroke="#7cc0ff" strokeWidth="2" opacity="0.8" strokeLinecap="round" />}
        </svg>
    );
}

// Focal length as a compact field-of-view wedge + the millimetre number.
export function FocalGlyph({ mm = 50, size = 58 }) {
    // Narrower wedge as focal length grows (tighter FOV).
    const half = clamp(46 - (Number(mm) - 14) / 200 * 38, 6, 46);
    const rad = (deg) => (deg * Math.PI) / 180;
    const x2 = 78 * Math.cos(rad(half)), y2 = 78 * Math.sin(rad(half));
    return (
        <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <g transform="translate(14,50)">
                <path d={`M0 0 L ${x2.toFixed(1)} ${(-y2).toFixed(1)} M0 0 L ${x2.toFixed(1)} ${y2.toFixed(1)}`} opacity="0.7" />
                <path d={`M ${x2.toFixed(1)} ${(-y2).toFixed(1)} A 78 78 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`}
                    fill="rgba(255,255,255,0.07)" stroke="currentColor" strokeWidth="2" opacity="0.6" />
                <circle cx="0" cy="0" r="3.5" fill="currentColor" opacity="0.5" stroke="none" />
            </g>
        </svg>
    );
}
