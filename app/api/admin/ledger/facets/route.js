import { NextResponse } from 'next/server';
import { gatewayContext } from '../../../../../lib/gateway/authz.js';
import { facetQuery } from '../../../../../lib/ledger/filters.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The values the ledger's filter dropdowns offer.
//
// Derived from ledger_rows — the same table the list reads — and not from the
// models / users / projects tables. A dropdown built from those catalogues
// would offer models nobody has ever run, and would lose the ones that were
// renamed or deleted since the generations that used them. Building it from
// the rows means every option returns at least one row, and history keeps the
// name it was generated under.
//
//   GET /api/admin/ledger/facets?workbook=video
//   GET /api/admin/ledger/facets?media=Image
//
// Scoped by workbook and media only, deliberately NOT by the other filters:
// cascading them would let a chosen model empty the user list and strand a
// selection that the admin then cannot see to clear. The counts are per
// option, within that scope.

const MEDIA_VALUES = new Set(['Image', 'Video']);

async function facet(sql, name, options) {
    const { text, values } = facetQuery(name, options);
    return sql.query(text, values);
}

export async function GET(request) {
    const auth = await gatewayContext({ permission: 'ledger.view' });
    if (!auth.ok) return auth.response;
    const { sql } = auth.ctx;

    const params = new URL(request.url).searchParams;
    const workbook = params.get('workbook') === 'video' ? 'video' : 'master';

    // The video workbook is video-only by construction, so its dropdowns must
    // not offer an image-only model that would return an empty table.
    const requested = params.get('media');
    const media = workbook === 'video'
        ? 'Video'
        : (MEDIA_VALUES.has(requested) ? requested : null);

    const [models, users, projects] = await Promise.all([
        facet(sql, 'model', { media }),
        // Matched on the address, shown as the person.
        facet(sql, 'user', { media, labelColumn: 'User Name' }),
        facet(sql, 'project', { media }),
    ]);

    return NextResponse.json({ workbook, media, models, users, projects });
}
