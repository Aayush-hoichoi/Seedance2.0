// Reassign N recent completed videos to a user so they appear in that user's
// studio history (ownership = usage_events.user_id). For testing the per-user
// history rail. Reversible — the original owner of each task is printed.
//
//   node --env-file=.env.local scripts/map-videos-to-me.mjs [email] [count]
//   node --env-file=.env.local scripts/map-videos-to-me.mjs aayush@hoichoi.tv 2
//   node --env-file=.env.local scripts/map-videos-to-me.mjs user_abc123 2   (pass a user id directly)

import { getDb } from '../lib/db/neon.js';

const arg = (process.argv[2] || 'aayush@hoichoi.tv').trim();
const count = Math.max(1, Math.min(10, Number(process.argv[3]) || 2));

const sql = await getDb();
if (!sql) { console.error('No DB — set DATABASE_URL.'); process.exit(1); }

// Resolve the target user id: a direct id (user_…) wins; else look up by email
// in the users mirror, then fall back to usage_events.
let userId = arg.startsWith('user_') ? arg : null;
let userEmail = arg.includes('@') ? arg : null;
if (!userId) {
    try {
        const [u] = await sql`SELECT id, email FROM users WHERE lower(email) = lower(${arg}) LIMIT 1`;
        if (u) { userId = u.id; userEmail = u.email; }
    } catch { /* users table may differ */ }
    if (!userId) {
        const [e] = await sql`SELECT user_id, user_email FROM usage_events
            WHERE lower(user_email) = lower(${arg}) AND user_id IS NOT NULL LIMIT 1`;
        if (e) { userId = e.user_id; userEmail = e.user_email; }
    }
}
if (!userId) {
    console.error(`Could not find a user id for "${arg}".`);
    // Print who exists so the caller can pick the right email or user_… id.
    try {
        const us = await sql`SELECT id, email, name FROM users ORDER BY email LIMIT 50`;
        if (us.length) {
            console.error('\nKnown users (user_id — email):');
            for (const u of us) console.error(`  ${u.id} — ${u.email || u.name || '?'}`);
        }
    } catch { /* users table shape may differ */ }
    try {
        const cr = await sql`SELECT user_id, max(user_email) AS email, count(*) AS n
            FROM usage_events WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY n DESC LIMIT 50`;
        if (cr.length) {
            console.error('\nCreators with videos (user_id — email — #videos):');
            for (const c of cr) console.error(`  ${c.user_id} — ${c.email || '?'} — ${c.n}`);
        }
    } catch { /* ignore */ }
    console.error('\nRe-run with the correct email or the user_… id as the first argument.');
    process.exit(1);
}
console.log(`Target user: ${userEmail || '(unknown email)'} (${userId})`);

// Newest completed, non-binned videos not already owned by the target. Newest
// first so they fall inside ModelArk's recent-tasks window the rail merges from.
const candidates = await sql`
    SELECT e.task_id, e.user_id AS old_user, e.user_email AS old_email,
           left(coalesce(p.user_prompt, p.generated_prompt, ''), 60) AS prompt
    FROM usage_events e
    JOIN seedance_prompts p ON p.task_id = e.task_id
    WHERE e.status = 'succeeded' AND coalesce(p.deleted, false) = false AND e.user_id <> ${userId}
    ORDER BY e.created_at DESC
    LIMIT ${count}`;
if (!candidates.length) { console.error('No candidate videos found to reassign.'); process.exit(1); }

console.log(`\nReassigning ${candidates.length} video(s) to you:`);
for (const c of candidates) {
    console.log(`  ${c.task_id}  (was ${c.old_email || c.old_user})  "${c.prompt}"`);
    if (userEmail) {
        await sql`UPDATE usage_events SET user_id = ${userId}, user_email = ${userEmail} WHERE task_id = ${c.task_id}`;
    } else {
        await sql`UPDATE usage_events SET user_id = ${userId} WHERE task_id = ${c.task_id}`;
    }
}
console.log(`\nDone — reload the studio (Default project) and these appear in your History.`);
console.log('Revert: UPDATE usage_events SET user_id = <old owner> WHERE task_id = <task>;');
process.exit(0);
