import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { recoverGeneration, restoreBinned, objectExists } from '../lib/seedance/recovery.mjs';

test('restores hidden legacy and current items with attribution, once', async () => {
    const db = new PGlite();
    try {
        await db.exec(`CREATE TABLE seedance_prompts(task_id text PRIMARY KEY, deleted boolean);
            CREATE TABLE audit_log(id serial, actor_id text, actor_email text, action text, target_type text, target_id text, before jsonb, after jsonb);
            INSERT INTO seedance_prompts VALUES ('legacy',true),('current',true),('visible',false);`);
        const sql = { query: async (text, values) => (await db.query(text, values)).rows };
        assert.equal(await restoreBinned(sql, { userId: 'admin1', email: 'admin@example.com' }), 2);
        assert.equal(await restoreBinned(sql, { userId: 'admin1', email: 'admin@example.com' }), 0);
        const audit = (await db.query('SELECT * FROM audit_log')).rows;
        assert.equal(audit.length, 2);
        assert.ok(audit.every(row => row.actor_id === 'admin1' && row.after.deleted === false));
        assert.equal((await db.query('SELECT * FROM seedance_prompts WHERE deleted')).rows.length, 0);
    } finally { await db.close(); }
});

test('existing video gets its missing pointer repaired without fetching or overwriting', async () => {
    const outcome = await recoverGeneration({ id: 1, provider_task_id: 'task1', result: {} }, {
        exists: async () => true,
        read: async () => assert.fail('must not fetch'), write: async () => assert.fail('must not overwrite'),
    });
    assert.equal(outcome.result.video_key, 'videos/task1.mp4');
    assert.equal(outcome.recovered, 0);
});

test('missing video is saved before its storage pointer is set', async () => {
    const writes = [];
    const outcome = await recoverGeneration({ id: 1, provider_task_id: 'task1', result: { video_url: 'source' } }, {
        exists: async () => false, read: async () => Buffer.from('video'),
        write: async (...args) => writes.push(args),
    });
    assert.equal(writes[0][0], 'videos/task1.mp4');
    assert.equal(outcome.recovered, 1);
    assert.equal(outcome.result.video_key, 'videos/task1.mp4');
});

test('expired source leaves result untouched and reports the problem', async () => {
    const outcome = await recoverGeneration({ id: 2, provider_task_id: 'task2', result: { video_url: 'expired' } }, {
        exists: async () => false, read: async () => { throw new Error('Source expired'); },
        write: async () => assert.fail('must not write'),
    });
    assert.equal(outcome.result.video_key, undefined);
    assert.deepEqual(outcome.problems, ['Source expired']);
});

test('multi-image recovery preserves existing files and reports partial failures', async () => {
    const writes = [];
    const outcome = await recoverGeneration({ id: 3, category: 'image', result: { images: [
        { key: 'existing' }, { b64: 'aGk=', mimeType: 'image/jpeg' }, { key: 'lost' },
    ] } }, {
        exists: async key => key === 'existing',
        read: async () => { throw new Error('No source'); }, write: async key => writes.push(key),
    });
    assert.deepEqual(writes, ['images/job-3-1.jpg']);
    assert.equal(outcome.result.images[0].key, 'existing');
    assert.equal(outcome.result.images[1].key, 'images/job-3-1.jpg');
    assert.equal(outcome.result.images[2].key, 'lost');
    assert.equal(outcome.problems.length, 1);
});

test('storage denial is never treated as a missing file', async () => {
    const oldAk = process.env.ARK_AK, oldSk = process.env.ARK_SK;
    process.env.ARK_AK = 'test'; process.env.ARK_SK = 'test';
    try {
        await assert.rejects(objectExists('videos/test.mp4', async () => new Response(null, { status: 403 })), /Storage check failed/);
        assert.equal(await objectExists('videos/test.mp4', async () => new Response(null, { status: 404 })), false);
    } finally {
        if (oldAk === undefined) delete process.env.ARK_AK; else process.env.ARK_AK = oldAk;
        if (oldSk === undefined) delete process.env.ARK_SK; else process.env.ARK_SK = oldSk;
    }
});
