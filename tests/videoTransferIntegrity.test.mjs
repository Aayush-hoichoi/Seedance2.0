import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { transcodeUrlToProRes, transcodeUrlToQuickTime } from '../lib/seedance/ensureH264.mjs';

test('streamed conversions reject truncated HTTP sources instead of returning a shorter successful video', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'video-transfer-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const sourcePath = join(dir, 'source.mp4');
    execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:duration=4:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-c:v', 'libx264', '-g', '24', '-bf', '0', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-movflags', '+faststart', sourcePath,
    ], { stdio: 'pipe' });
    const source = await readFile(sourcePath);
    // Leave enough complete packets to make a playable partial output. This
    // reproduces the dangerous case where ordinary ffmpeg exits successfully.
    const cutoff = Math.floor(source.length / 3);
    const server = http.createServer((request, response) => {
        const mode = new URL(request.url, 'http://localhost').pathname.slice(1);
        const start = Number(/bytes=(\d+)-/.exec(request.headers.range || '')?.[1] || 0);
        const end = mode === 'full' ? source.length : cutoff;
        const declared = mode === 'honest-short' ? end : source.length;
        if (start >= end) { response.writeHead(416); response.end(); return; }
        response.writeHead(206, {
            'Content-Type': 'video/mp4', 'Content-Length': declared - start,
            'Content-Range': `bytes ${start}-${declared - 1}/${declared}`,
            'Accept-Ranges': 'bytes', Connection: 'close',
        });
        if (mode === 'socket-cut') response.write(source.subarray(start, end), () => response.destroy());
        else response.end(source.subarray(start, end));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    for (const [name, convert] of [['ProRes', transcodeUrlToProRes], ['QuickTime', transcodeUrlToQuickTime]]) {
        for (const mode of ['full', 'declared-full', 'honest-short', 'socket-cut']) {
            await t.test(`${name}: ${mode}`, async () => {
                const conversion = convert(`http://127.0.0.1:${server.address().port}/${mode}?Signature=private-test-signature`);
                const chunks = [];
                const consume = async () => { for await (const chunk of conversion.stream) chunks.push(chunk); };
                try {
                    if (mode !== 'full') {
                        await assert.rejects(consume, (error) => {
                            assert.match(error.message, /conversion failed|source.*incomplete|read.*complet/i);
                            assert.equal(error.message.includes('private-test-signature'), false);
                            assert.equal(error.message.includes('127.0.0.1'), false);
                            return true;
                        });
                    } else {
                        await consume();
                        const outputPath = join(dir, `${name}.mov`);
                        await writeFile(outputPath, Buffer.concat(chunks));
                        let info = '';
                        try { execFileSync(ffmpegPath, ['-hide_banner', '-i', outputPath], { stdio: 'pipe' }); }
                        catch (error) { info = String(error.stderr); }
                        assert.match(info, /Duration: 00:00:04\./, 'the full source must keep its four-second duration');
                        assert.match(info, name === 'ProRes' ? /Video: prores/ : /Video: h264/);
                        const progress = execFileSync(ffmpegPath, [
                            '-v', 'error', '-i', outputPath, '-map', '0:v:0',
                            '-progress', 'pipe:1', '-nostats', '-f', 'null', '-',
                        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
                        const frames = [...progress.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1];
                        assert.equal(Number(frames), 96, 'all 96 source frames must survive the conversion');
                    }
                } finally { conversion.cancel(); await conversion.done; }
            });
        }
    }
});
