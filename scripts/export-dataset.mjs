// Export the training dataset — one JSONL line per generation, mapping the
// INPUT (prompt + reference assets) to the OUTPUT object plus the engagement
// signal (downloads + likes). Reads the dataset_samples view (lib/db/schema.mjs).
//
// Media stays in TOS; each record carries the stable object `key` (durable
// forever) AND a freshly presigned 7-day `url` (usable immediately). Nothing is
// copied — the manifest + the existing objects ARE the dataset.
//
//   node --env-file=.env.local scripts/export-dataset.mjs [outFile] [--confirmed-only] [--limit N]
//   node --env-file=.env.local scripts/export-dataset.mjs dataset.jsonl --confirmed-only
//
//   --confirmed-only  only rows whose output object is known to exist in TOS
//                     (every video from now on; pre-fix videos may be missing).
//   --limit N         cap the number of rows (newest first). Default: all.

import { writeFileSync } from 'node:fs';
import { getDb } from '../lib/db/neon.js';
import { presignKey } from '../lib/seedance/galleryItem.mjs';

const args = process.argv.slice(2);
const confirmedOnly = args.includes('--confirmed-only');
const limIdx = args.indexOf('--limit');
const limit = limIdx >= 0 ? Math.max(1, Number(args[limIdx + 1]) || 0) : null;
const outFile = args.find((a) => !a.startsWith('--') && a !== String(limit)) || 'dataset.jsonl';

const sql = await getDb();
if (!sql) { console.error('No DB — set DATABASE_URL (node --env-file=.env.local …).'); process.exit(1); }

// One reference input → { role, kind, key, url }. Prefer the durable uploads/<…>
// tosKey (re-presignable forever); fall back to whatever URL was recorded.
function shapeRef(r) {
    if (!r || typeof r !== 'object') return null;
    const key = typeof r.tosKey === 'string' ? r.tosKey : null;
    return {
        role: r.role ?? null,
        kind: r.kind ?? null,
        key,
        url: key ? presignKey(key) : (r.url ?? null),
    };
}

// neon has no fragment composition — push the conditionals in as parameters.
// LIMIT NULL means "no limit" in Postgres, so a null `limit` returns everything.
const rows = await sql`
    SELECT task_id, user_id, user_email, model_id, category,
           resolution, duration, ratio, mode, created_at,
           prompt, user_prompt, generated_prompt, style,
           input_refs, output_key, output_confirmed, downloads, likes
    FROM dataset_samples
    WHERE (${confirmedOnly}::boolean = false OR output_confirmed = true)
    ORDER BY created_at DESC
    LIMIT ${limit}`;

let written = 0, unconfirmed = 0, withRefs = 0, engaged = 0;
const lines = [];
for (const r of rows) {
    const refs = (Array.isArray(r.input_refs) ? r.input_refs : []).map(shapeRef).filter(Boolean);
    if (refs.length) withRefs += 1;
    if (!r.output_confirmed) unconfirmed += 1;
    if (r.downloads > 0 || r.likes > 0) engaged += 1;
    lines.push(JSON.stringify({
        task_id: r.task_id,
        created_at: r.created_at,
        user_id: r.user_id,
        user_email: r.user_email,
        model_id: r.model_id,
        category: r.category,
        params: { resolution: r.resolution, duration: r.duration, ratio: r.ratio, mode: r.mode },
        prompt: r.prompt,
        user_prompt: r.user_prompt,
        generated_prompt: r.generated_prompt,
        style: r.style,
        input_refs: refs,
        output: { key: r.output_key, url: presignKey(r.output_key), confirmed: r.output_confirmed },
        downloads: r.downloads,
        likes: r.likes,
    }));
    written += 1;
}

writeFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
console.log(`Wrote ${written} sample(s) → ${outFile}`);
console.log(`  with reference inputs: ${withRefs}`);
console.log(`  with engagement (download/like): ${engaged}`);
console.log(`  output UNconfirmed (object may be missing): ${unconfirmed}${confirmedOnly ? ' (excluded)' : ''}`);
process.exit(0);
