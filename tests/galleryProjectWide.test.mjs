import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { queryGalleryProjects, queryProjectGenerations, queryProjectGenerationSummary } from '../lib/access/galleryQueries.mjs';

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

test('project gallery includes visible generations from every creator and reports the same totals', async () => {
    const db = new PGlite();
    try {
        await db.exec(`
            CREATE TABLE projects (id integer PRIMARY KEY, name text NOT NULL, archived_at timestamptz);
            CREATE TABLE users (id text PRIMARY KEY, name text, email text);
            CREATE TABLE seedance_prompts (
                task_id text PRIMARY KEY, user_prompt text, generated_prompt text,
                style text, refs jsonb, liked boolean DEFAULT false, deleted boolean DEFAULT false
            );
            CREATE TABLE exr_jobs (
                id serial PRIMARY KEY, user_id text, request_body jsonb,
                status text, result jsonb, finished_at timestamptz
            );
            CREATE TABLE jobs (
                id serial PRIMARY KEY, provider_task_id text, user_id text,
                created_at timestamptz, finished_at timestamptz, status text
            );
            CREATE TABLE gallery_generations (
                task_id text, user_id text, user_email text, model_id text, resolution text,
                duration integer, ratio text, mode text, status text, created_at timestamptz,
                category text, image_key text, image_prompt text, images jsonb, project_id integer
            );
            INSERT INTO projects VALUES (10, 'Film A', null), (20, 'Film B', null), (30, 'Archived Film', '2026-10-10T00:00:00Z');
            INSERT INTO users VALUES ('u1', 'Ari', 'ari@example.com'), ('u2', 'Bea', 'bea@example.com');
            INSERT INTO gallery_generations
                (task_id,user_id,user_email,model_id,status,created_at,category,image_key,image_prompt,project_id)
            VALUES
                ('video-a','u1','ari@example.com','seedance-2.0','succeeded','2026-10-10T12:00:00Z','video',null,null,10),
                ('image-b','u2','bea@example.com','nano-banana-2','succeeded','2026-10-10T13:00:00Z','image','images/b.png','a still',10),
                ('other-project','u2','bea@example.com','seedance-2.0','succeeded','2026-10-10T14:00:00Z','video',null,null,20),
                ('archived-project','u1','ari@example.com','seedance-2.0','succeeded','2026-10-10T15:30:00Z','video',null,null,30),
                ('failed-a','u1','ari@example.com','seedance-2.0','failed','2026-10-10T15:00:00Z','video',null,null,10),
                ('deleted-a','u1','ari@example.com','seedance-2.0','succeeded','2026-10-10T16:00:00Z','video',null,null,10);
            INSERT INTO seedance_prompts (task_id, user_prompt, deleted)
            VALUES ('video-a', 'a video', false), ('deleted-a', 'hidden', true);
        `);

        const sql = neonLike(db);
        const rows = await queryProjectGenerations(sql, { projectId: 10 });
        assert.deepEqual(rows.map((row) => row.task_id), ['image-b', 'video-a']);
        assert.deepEqual(rows.map((row) => row.creator_name), ['Bea', 'Ari']);
        assert.deepEqual(rows.map((row) => row.project_name), ['Film A', 'Film A']);

        const summary = await queryProjectGenerationSummary(sql, { projectId: 10 });
        assert.deepEqual({
            name: summary.name,
            generations: summary.generations,
            images: summary.images,
            videos: summary.videos,
        }, { name: 'Film A', generations: 2, images: 1, videos: 1 });

        const projects = await queryGalleryProjects(sql);
        assert.deepEqual(projects.map((project) => project.name), ['Film B', 'Film A']);
        assert.deepEqual(projects.map((project) => project.generations), [1, 2]);
    } finally {
        await db.close();
    }
});
