import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { ensureH264 } from '../lib/seedance/ensureH264.mjs';

const dir = mkdtempSync(join(tmpdir(), 'h264test-'));

function make(codec, file) {
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=red:size=128x128:d=0.5', '-c:v', codec, '-pix_fmt', 'yuv420p', join(dir, file)], { stdio: 'ignore' });
    return readFileSync(join(dir, file));
}

function codecOf(buf) {
    const f = join(dir, 'probe.mp4');
    writeFileSync(f, buf);
    try { execFileSync(ffmpegPath, ['-hide_banner', '-i', f], { stdio: 'pipe' }); } catch (e) {
        return /Video:\s*([a-z0-9_]+)/i.exec(String(e.stderr))?.[1];
    }
}

test('hevc input is re-encoded to h264', async () => {
    const hevc = make('libx265', 'in-hevc.mp4');
    assert.equal(codecOf(hevc), 'hevc');
    const out = await ensureH264(hevc, 'clip.mp4');
    assert.equal(codecOf(out), 'h264');
});

test('h264 input passes through untouched', async () => {
    const h264 = make('libx264', 'in-h264.mp4');
    const out = await ensureH264(h264, 'clip.mp4');
    assert.equal(out, h264); // same buffer, no re-encode
});

test('non-video names pass through', async () => {
    const buf = Buffer.from('not a video');
    assert.equal(await ensureH264(buf, 'image.png'), buf);
});
