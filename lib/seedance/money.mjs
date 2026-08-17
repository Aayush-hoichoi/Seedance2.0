// Money display for the studio chrome. One formatter so the project chip and
// the budget badge — which sit inches apart in the same header — can never
// drift into showing "$21.4" beside "$21.40".
//
// No 'use client': this is a pure string helper with no runtime of its own, so
// server code can share it. A module that carries the directive turns its
// exports into client references, and calling one from the server throws.
//
// Always two decimals. Sub-cent precision belongs in the console's reports
// (app/console/lib.js fmtUsd goes to 4), not in a badge read at a glance.
// style:'currency' rather than a manual '$' + toLocaleString: it puts the sign
// in front of the symbol. A budget can go negative under a soft-overage policy,
// and hand-prefixing renders that as "$-5.00".
const FORMAT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function usd(value) {
    const n = Number(value);
    return FORMAT.format(Number.isFinite(n) ? n : 0);
}
