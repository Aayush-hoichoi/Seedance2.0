// One-shot rescue: re-archive gallery videos whose TOS object went missing
// (e.g. wiped by a bucket lifecycle rule) while their ModelArk provider URL
// (~24h) is still alive. Idempotent and safe to re-run: objects that already
// exist are skipped, dead provider links are just counted.
//
// Run with VALID TOS keys (ARK_AK/ARK_SK):
//   node --env-file=.env.local scripts/rescue-video-archives.mjs

import { getDb } from '../lib/db/neon.js';
import { archiveVideo } from '../lib/seedance/archiveVideo.mjs';
import { presignKey } from '../lib/seedance/galleryItem.mjs';

const sql = await getDb();
if (!sql) throw new Error('DATABASE_URL is not configured.');

const rows = await sql`
    SELECT g.task_id, g.video_key, j.result->>'video_url' AS provider_url
    FROM gallery_generations g
    JOIN jobs j ON j.provider_task_id = g.task_id
    WHERE g.category = 'video' AND g.status = 'succeeded'
      AND j.result->>'video_url' IS NOT NULL
    ORDER BY g.created_at DESC`;

let ok = 0, present = 0, dead = 0, failed = 0;
for (const row of rows) {
    const url = presignKey(row.video_key || `videos/${row.task_id}.mp4`);
    if (url && (await fetch(url, { method: 'HEAD' })).ok) { present += 1; continue; }
    try {
        await archiveVideo({ url: row.provider_url, taskId: row.task_id });
        ok += 1;
        console.log(`rescued ${row.task_id}`);
    } catch (error) {
        // 502 with an upstream 403/404 = the provider link has expired.
        if (/\(40[34]\)/.test(error.message)) dead += 1;
        else { failed += 1; console.error(`FAILED ${row.task_id}: ${error.message}`); }
    }
}
console.log(`done: ${ok} rescued, ${present} already present, ${dead} provider links expired, ${failed} failed of ${rows.length}`);
