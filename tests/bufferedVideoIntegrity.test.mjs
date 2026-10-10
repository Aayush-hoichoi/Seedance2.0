import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Transform } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { ensureH264, remuxToMov, retimeToFps } from '../lib/seedance/ensureH264.mjs';

const converters = [['H.264', ensureH264], ['MOV', remuxToMov], ['25 fps', retimeToFps]];

for (const [label, convert] of converters) {
    test(`${label} rejects unreadable video instead of returning corrupt source or a silent fallback`, async () => {
        await assert.rejects(convert(Buffer.from('broken private-source?Signature=secret'), 'video.mp4'), (error) => {
            assert.match(error.message, /conversion failed/i);
            assert.doesNotMatch(error.message, /private-source|Signature|secret|\/tmp\//);
            return true;
        });
    });
}

test('truncated HEVC and H.264 files cannot be returned as successful complete downloads', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'buffered-integrity-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const codec of ['libx265', 'libx264']) {
        const path = join(dir, `${codec}.mp4`);
        childProcess.execFileSync(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=128x64:duration=4:rate=24',
            '-c:v', codec, '-threads', '2', '-g', '24', '-bf', '0', '-pix_fmt', 'yuv420p',
            ...(codec === 'libx265' ? ['-x265-params', 'pools=1:frame-threads=1:log-level=error'] : []),
            '-movflags', '+faststart', path,
        ], { stdio: 'ignore' });
        const source = await readFile(path);
        const truncated = source.subarray(0, Math.floor(source.length * 0.6));
        for (const [label, convert] of converters) {
            await t.test(`${codec} → ${label}`, async () => {
                await assert.rejects(convert(truncated, 'video.mp4'), /conversion failed/i);
            });
        }
    }
});

test('a zero-exit encoder that produced only part of the duration is rejected', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'buffered-short-output-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'source.mp4');
    childProcess.execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=128x64:duration=4:rate=24',
        '-c:v', 'libx265', '-threads', '2', '-x265-params', 'pools=1:frame-threads=1:log-level=error', path,
    ], { stdio: 'ignore' });
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', (command, args, options) => {
        // Fault injection: a successful encoder can still emit a short valid
        // MP4, as the production truncation incident demonstrated.
        const actual = args.includes('libx264') ? [...args.slice(0, -1), '-t', '1', args.at(-1)] : args;
        return spawn(command, actual, options);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(ensureH264(await readFile(path), 'video.mp4'), /conversion failed/i);
});

test('60 fps video with audio retimes to 25 fps without silently keeping the original speed', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'retime-audio-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = join(dir, 'source.mp4');
    childProcess.execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=128x64:duration=4:rate=60',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', source,
    ], { stdio: 'ignore' });
    const result = await retimeToFps(await readFile(source), 'video.mp4', 25);
    assert.ok(result?.length);
    const output = join(dir, 'retimed.mp4');
    await writeFile(output, result);
    const decoded = childProcess.spawnSync(ffmpegPath, [
        '-hide_banner', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-',
    ], { encoding: 'utf8' });
    assert.equal(decoded.status, 0);
    assert.match(decoded.stderr, /Video: h264/);
    assert.match(decoded.stderr, /25 fps/);
    assert.match(decoded.stderr, /Audio: aac/);
    assert.match(decoded.stderr, /Duration: 00:00:09\.6/);
    assert.match(decoded.stderr, /frame=\s*240\b/);
});

test('a valid video track is not rejected because its audio continues longer', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'video-audio-tail-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = join(dir, 'source.mp4');
    childProcess.execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=128x64:duration=2:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', source,
    ], { stdio: 'ignore' });
    const input = await readFile(source);
    for (const [label, convert] of converters) {
        const result = await convert(input, 'video.mp4');
        assert.ok(result?.length, label);
        const output = join(dir, `${label.replace(/[^a-z0-9]/gi, '')}.mov`);
        await writeFile(output, result);
        const decoded = childProcess.spawnSync(ffmpegPath, [
            '-hide_banner', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-',
        ], { encoding: 'utf8' });
        assert.equal(decoded.status, 0, label);
        assert.match(decoded.stderr, /frame=\s*48\b/, label);
        assert.match(decoded.stderr, /Audio: aac/, label);
    }
});

test('a valid video with a leading empty edit retains every frame', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'video-leading-edit-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const original = join(dir, 'original.mp4');
    const delayed = join(dir, 'delayed.mp4');
    childProcess.execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=128x64:duration=2:rate=24',
        '-c:v', 'libx264', '-threads', '2', original,
    ], { stdio: 'ignore' });
    childProcess.execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-itsoffset', '1',
        '-i', original, '-map', '0:v:0', '-c', 'copy', delayed,
    ], { stdio: 'ignore' });
    for (const [label, convert] of converters) {
        const result = await convert(await readFile(delayed), 'video.mp4');
        assert.ok(result?.length, label);
        const output = join(dir, `${label.replace(/[^a-z0-9]/gi, '')}.mov`);
        await writeFile(output, result);
        const decoded = childProcess.spawnSync(ffmpegPath, [
            '-hide_banner', '-i', output, '-map', '0:v:0', '-f', 'null', '-',
        ], { encoding: 'utf8' });
        assert.equal(decoded.status, 0, label);
        assert.match(decoded.stderr, /frame=\s*48\b/, label);
    }
});

test('FFmpeg 6.1 stream-copy progress without frame counts validates complete video only', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'video-progress-version-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = join(dir, 'source.mp4');
    const single = join(dir, 'single.mp4');
    childProcess.execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=128x64:duration=4:rate=24',
        '-c:v', 'libx265', '-threads', '2', '-x265-params', 'pools=1:frame-threads=1:log-level=error', source,
    ], { stdio: 'ignore' });
    childProcess.execFileSync(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-frames:v', '1', '-c:v', 'libx264', '-threads', '2', single,
    ], { stdio: 'ignore' });
    const input = await readFile(source);
    const oneFrame = await readFile(single);
    const spawn = childProcess.spawn;
    let mode = 'full';
    t.mock.method(childProcess, 'spawn', (command, args, options) => {
        const actual = mode === 'short' && args.includes('libx264')
            ? [...args.slice(0, -1), '-t', '1', args.at(-1)] : args;
        const child = spawn(command, actual, options);
        if (args.includes('-progress') && args.includes('copy')) {
            let pending = '';
            const rewrite = (line) => {
                if (/^frame=/.test(line)) return '';
                if (/^out_time_us=/.test(line)) {
                    if (mode === 'single') return 'out_time_us=0\n';
                    if (mode === 'empty') return 'out_time_us=N/A\n';
                }
                return (mode === 'zero' && /^progress=/.test(line) ? 'frame=0\n' : '') + line + '\n';
            };
            // Reproduce FFmpeg 6.1's actual progress protocol while the real
            // encoder and packet reader still process every source/output.
            const filtered = new Transform({
                transform(chunk, encoding, callback) {
                    pending += String(chunk);
                    const lines = pending.split('\n');
                    pending = lines.pop();
                    callback(null, lines.map(rewrite).join(''));
                },
                flush(callback) { callback(null, pending ? rewrite(pending) : ''); },
            });
            child.stdout.pipe(filtered);
            child.stdout = filtered;
        }
        return child;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await t.test('complete outputs remain accepted', async () => {
        for (const [label, convert] of converters) {
            const output = await convert(input, 'video.mp4');
            assert.ok(output?.length, label);
        }
    });
    await t.test('a successful but short encoder output still rejects', async () => {
        mode = 'short';
        await assert.rejects(ensureH264(input, 'video.mp4'), /conversion failed/i);
    });
    await t.test('a single frame at timestamp zero remains valid', async () => {
        mode = 'single';
        assert.equal(await ensureH264(oneFrame, 'video.mp4'), oneFrame);
    });
    await t.test('an explicit zero frame count rejects', async () => {
        mode = 'zero';
        await assert.rejects(ensureH264(oneFrame, 'video.mp4'), /conversion failed/i);
    });
    await t.test('no frames and no numeric output timestamp rejects', async () => {
        mode = 'empty';
        await assert.rejects(ensureH264(oneFrame, 'video.mp4'), /conversion failed/i);
    });
});
