import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { ensureH264, retimeToFps, transcodeToProRes, transcodeUrlToQuickTime } from '../lib/seedance/ensureH264.mjs';

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

test('prores download keeps 10-bit 4:4:4', async () => {
    // Mimic a Seedance 2.5 original: 10-bit 4:4:4 HEVC.
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=red:size=128x128:d=0.5', '-c:v', 'libx265', '-pix_fmt', 'yuv444p10le', join(dir, 'in-10bit.mp4')], { stdio: 'ignore' });
    const src = readFileSync(join(dir, 'in-10bit.mp4'));
    const out = await transcodeToProRes(src, 'clip.mp4');
    assert.ok(out?.length, 'prores conversion must produce output');
    const f = join(dir, 'probe-prores.mov');
    writeFileSync(f, out);
    let info = '';
    try { execFileSync(ffmpegPath, ['-hide_banner', '-i', f], { stdio: 'pipe' }); } catch (e) { info = String(e.stderr); }
    assert.match(info, /prores/i, 'video stream must be ProRes');
    // prores_ks stores 4444 as 12-bit (yuv444p12le) — deeper than the 10-bit
    // source, so nothing is lost. Accept 10 or 12.
    assert.match(info, /yuv444p1[02]/i, '≥10-bit 4:4:4 must survive the conversion');
});

test('25 fps retime delivers 25 fps h264', async () => {
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=red:size=128x128:d=0.5:rate=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'in-24fps.mp4')], { stdio: 'ignore' });
    const src = readFileSync(join(dir, 'in-24fps.mp4'));
    const out = await retimeToFps(src, 'clip.mp4', 25);
    assert.ok(out?.length, 'retime must produce output');
    const f = join(dir, 'probe-25fps.mp4');
    writeFileSync(f, out);
    let info = '';
    try { execFileSync(ffmpegPath, ['-hide_banner', '-i', f], { stdio: 'pipe' }); } catch (e) { info = String(e.stderr); }
    assert.match(info, /\b25 fps\b/, 'output must be 25 fps');
    assert.match(info, /Video:\s*h264/i, 'output must be h264');
});

test('retime to the source rate is a no-op signal (null)', async () => {
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=red:size=128x128:d=0.5:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'in-25fps.mp4')], { stdio: 'ignore' });
    const src = readFileSync(join(dir, 'in-25fps.mp4'));
    assert.equal(await retimeToFps(src, 'clip.mp4', 25), null, 'same-rate retime must signal no work');
});

test('large video can be streamed into a QuickTime-compatible MOV', async () => {
    make('ffv1', 'in-ffv1.mov');
    const conversion = transcodeUrlToQuickTime(pathToFileURL(join(dir, 'in-ffv1.mov')).href);
    const chunks = [];
    try {
        for await (const chunk of conversion.stream) chunks.push(chunk);
    } finally {
        conversion.cancel();
    }
    const output = Buffer.concat(chunks);
    assert.ok(output.length > 0);
    assert.equal(codecOf(output), 'h264');
});
