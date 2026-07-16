import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVideoContent } from '../lib/mcp/videoContent.mjs';

test('prompt only → single text item', () => {
    assert.deepEqual(buildVideoContent({ prompt: 'a cat' }), [{ type: 'text', text: 'a cat' }]);
});

test('image ref → image_url item with role; video ref → video_url item', () => {
    const content = buildVideoContent({
        prompt: 'p',
        refs: [
            { url: 'https://x/a.png', role: 'first_frame' },
            { url: 'https://x/b.mp4', role: 'reference_video' },
        ],
    });
    assert.deepEqual(content[1], { type: 'image_url', role: 'first_frame', image_url: { url: 'https://x/a.png' } });
    assert.deepEqual(content[2], { type: 'video_url', role: 'reference_video', video_url: { url: 'https://x/b.mp4' } });
});

test('no refs → content is just the text item', () => {
    assert.deepEqual(buildVideoContent({ prompt: 'solo' }), [{ type: 'text', text: 'solo' }]);
});

test('reference_image role stays an image_url item', () => {
    const content = buildVideoContent({ prompt: 'p', refs: [{ url: 'https://x/c.png', role: 'reference_image' }] });
    assert.deepEqual(content[1], { type: 'image_url', role: 'reference_image', image_url: { url: 'https://x/c.png' } });
});
