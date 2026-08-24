import test from 'node:test';
import assert from 'node:assert/strict';

import {
    fallbackContentForGenerations,
    normalizeGeneration,
} from '../lib/mcp/media.mjs';
import { waitForGenerations } from '../lib/mcp/waitForGenerations.mjs';
import { MEDIA_APP_RESOURCE_URI } from '../lib/mcp/mediaAppConfig.mjs';
import { mediaAppHtml } from '../lib/mcp/ui/mediaAppHtml.mjs';

const NOW = new Date('2026-08-24T10:00:00.000Z');

function job(overrides = {}) {
    return {
        id: 42,
        project_id: 7,
        model_id: 'seedance-2.0',
        provider_task_id: 'task-abc',
        status: 'succeeded',
        request_body: { category: 'video', prompt: 'private prompt' },
        result: {},
        error: null,
        created_at: '2026-08-24T09:58:00.000Z',
        finished_at: '2026-08-24T09:59:00.000Z',
        ...overrides,
    };
}

test('normalizes stored images with freshly signed URLs and no prompt data', () => {
    const signed = [];
    const result = normalizeGeneration(job({
        request_body: { category: 'image', prompt: 'do not expose this' },
        model_id: 'nano-banana-2',
        result: { images: [{ key: 'images/job-42-0.png' }] },
    }), {
        now: NOW,
        signKey: (key, options) => {
            signed.push({ key, options });
            return `https://media.example/${key}?fresh=1`;
        },
    });

    assert.equal(result.generationId, 42);
    assert.equal(result.category, 'image');
    assert.equal(result.terminal, true);
    assert.equal(result.media.length, 1);
    assert.deepEqual(result.media[0], {
        id: '42-image-1',
        type: 'image',
        url: 'https://media.example/images/job-42-0.png?fresh=1',
        mimeType: 'image/png',
        filename: 'generation-42-1.png',
        source: 'archive',
        expiresAt: '2026-08-31T10:00:00.000Z',
    });
    assert.deepEqual(signed, [{
        key: 'images/job-42-0.png',
        options: { expiresSec: 604800, date: NOW },
    }]);
    assert.equal(JSON.stringify(result).includes('do not expose this'), false);
});

test('normalizes video from its archived key instead of an expired provider URL', () => {
    const result = normalizeGeneration(job({
        result: {
            video_key: 'videos/permanent.mp4',
            video_url: 'https://provider.example/expired.mp4',
        },
    }), {
        now: NOW,
        signKey: (key) => `https://media.example/${key}?fresh=1`,
    });

    assert.equal(result.media.length, 1);
    assert.equal(result.media[0].type, 'video');
    assert.equal(result.media[0].url, 'https://media.example/videos/permanent.mp4?fresh=1');
    assert.equal(result.media[0].source, 'archive');
    assert.equal(result.media[0].expiresAt, '2026-08-31T10:00:00.000Z');
});

test('pending generations tell an app when to poll and contain no media yet', () => {
    const result = normalizeGeneration(job({ status: 'running', result: null, finished_at: null }));
    assert.equal(result.terminal, false);
    assert.equal(result.pollAfterMs, 3000);
    assert.deepEqual(result.media, []);
});

test('fallback content includes Markdown video links for non-App clients', () => {
    const generations = [normalizeGeneration(job({
        result: { video_key: 'videos/final.mp4' },
    }), {
        now: NOW,
        signKey: () => 'https://media.example/final.mp4?signature=fresh',
    })];
    const [block] = fallbackContentForGenerations(generations);
    assert.equal(block.type, 'text');
    assert.match(block.text, /\[Watch video 42\]\(https:\/\/media\.example\/final\.mp4\?signature=fresh\)/);
});

test('long poll reloads several generations and stops when all are terminal', async () => {
    const snapshots = [
        [{ id: 1, status: 'running' }, { id: 2, status: 'queued' }],
        [{ id: 1, status: 'succeeded' }, { id: 2, status: 'failed' }],
    ];
    let loads = 0;
    let clock = 0;
    const result = await waitForGenerations({
        load: async () => snapshots[Math.min(loads++, snapshots.length - 1)],
        timeoutMs: 15_000,
        intervalMs: 1_000,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    });

    assert.equal(loads, 2);
    assert.equal(result.allTerminal, true);
    assert.deepEqual(result.jobs.map((item) => item.status), ['succeeded', 'failed']);
});

test('long poll returns the latest snapshot at its timeout', async () => {
    let loads = 0;
    let clock = 0;
    const result = await waitForGenerations({
        load: async () => {
            loads += 1;
            return [{ id: 1, status: 'running' }];
        },
        timeoutMs: 10_000,
        intervalMs: 3_000,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    });

    assert.equal(clock, 10_000);
    assert.equal(loads, 5);
    assert.equal(result.allTerminal, false);
    assert.equal(result.timedOut, true);
});

test('self-contained MCP App includes image/video rendering and app-only polling code', () => {
    const html = mediaAppHtml();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /text\/html|<main id="app"/);
    assert.match(html, /get_job_status/);
    assert.match(html, /createElement\("video"\)/);
    assert.match(html, /createElement\("img"\)/);
    assert.equal(html.includes('</script></script>'), false);
    assert.equal(MEDIA_APP_RESOURCE_URI.startsWith('ui://'), true);
});
