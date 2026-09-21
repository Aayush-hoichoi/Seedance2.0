import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { queryUserGenerations, queryUserGenerationProjects } from '../lib/access/galleryQueries.mjs';

function compile(strings, values) {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return { text, values };
}

function neonLike(db) {
    return function sql(strings, ...values) {
        const query = compile(strings, values);
        return db.query(query.text, query.values).then((result) => result.rows);
    };
}

async function fixture() {
    const db = new PGlite();
    await db.exec(`
        CREATE TABLE projects (id integer PRIMARY KEY, name text NOT NULL);
        CREATE TABLE seedance_prompts (
            task_id text PRIMARY KEY, user_prompt text, generated_prompt text,
            style text, refs jsonb, liked boolean DEFAULT false,
            deleted boolean DEFAULT false
        );
        CREATE TABLE gallery_generations (
            task_id text, user_id text, model_id text, resolution text,
            duration integer, ratio text, mode text, status text,
            created_at timestamptz, category text, image_key text,
            image_prompt text, project_id integer
        );
        INSERT INTO projects (id, name) VALUES (10, 'Film A'), (20, 'Film B');
        INSERT INTO gallery_generations
            (task_id, user_id, model_id, status, created_at, category, image_key, image_prompt, project_id)
        VALUES
            ('image-a', 'u1', 'image-model', 'succeeded', '2026-09-20T12:00:00Z', 'image', 'images/a.png', 'elephants', 10),
            ('video-a', 'u1', 'video-model', 'succeeded', '2026-09-20T11:00:00Z', 'video', null, null, 10),
            ('video-b', 'u1', 'video-model', 'succeeded', '2026-09-20T10:00:00Z', 'video', null, null, 20),
            ('failed-b', 'u1', 'video-model', 'failed', '2026-09-20T09:00:00Z', 'video', null, null, 20),
            ('other-user', 'u2', 'image-model', 'succeeded', '2026-09-20T08:00:00Z', 'image', 'images/other.png', 'other', 10);
        INSERT INTO seedance_prompts (task_id, user_prompt, deleted)
        VALUES ('video-a', 'video A', false), ('video-b', 'video B', true);
    `);
    return { db, sql: neonLike(db) };
}

test('gallery project filtering includes image jobs without prompt rows and excludes hidden work', async () => {
    const { db, sql } = await fixture();
    try {
        const rows = await queryUserGenerations(sql, { userId: 'u1', projectId: 10 });
        assert.deepEqual(rows.map((row) => row.task_id), ['image-a', 'video-a']);
        assert.deepEqual(rows.map((row) => row.project_id), [10, 10]);
        assert.deepEqual(rows.map((row) => row.project_name), ['Film A', 'Film A']);

        const projects = await queryUserGenerationProjects(sql, { userId: 'u1' });
        assert.deepEqual(projects.map((project) => ({
            id: project.project_id,
            generations: project.generations,
            images: project.images,
            videos: project.videos,
        })), [{ id: 10, generations: 2, images: 1, videos: 1 }]);
    } finally {
        await db.close();
    }
});
