import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { ensureH264, retimeToFps, transcodeToProRes } from '../lib/seedance/ensureH264.mjs';

// Scope matters: FFmpeg options before -i control decoding, while the later
// -threads controls encoding. Bounding only one still allows 4K frame buffers
// to exceed the function's memory budget. Exercise the actual encoder calls.
for (const [name, convert, codec, duration] of [
    ['H.264', ensureH264, 'h264', '04.00'],
    ['ProRes 4444', transcodeToProRes, 'prores', '04.00'],
    ['25 fps H.264', retimeToFps, 'h264', '03.84'],
]) {
    test(`${name} bounds decoder, filter and encoder threads while retaining the complete clip`, async (t) => {
        const dir = await mkdtemp(join(tmpdir(), 'conversion-memory-'));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const source = join(dir, 'input.mp4');
        childProcess.execFileSync(ffmpegPath, [
            '-y', '-f', 'lavfi', '-i', 'testsrc2=size=128x64:rate=24:duration=4',
            '-c:v', 'libx265', '-pix_fmt', 'yuv444p10le',
            '-x265-params', 'pools=1:frame-threads=1:log-level=error', source,
        ], { stdio: 'ignore' });
        const spawn = childProcess.spawn;
        const calls = [];
        t.mock.method(childProcess, 'spawn', (...args) => {
            calls.push(args[1]);
            return spawn(...args);
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        const result = await convert(await readFile(source), 'input.mp4', 25);
        assert.ok(result?.length, 'the conversion must produce bytes');
        const encode = calls.find((args) => args.includes('-c:v'));
        assert.ok(encode, 'the real encoder must run');
        const input = encode.indexOf('-i');
        const before = encode.slice(0, input);
        const after = encode.slice(input + 2);
        assert.equal(before[before.indexOf('-threads') + 1], '2', 'decode threads');
        assert.equal(before[before.indexOf('-filter_threads') + 1], '2', 'filter threads');
        assert.equal(after[after.indexOf('-threads') + 1], '2', 'encode threads');
        const output = join(dir, 'output.mov');
        await writeFile(output, result);
        const probe = childProcess.spawnSync(ffmpegPath, ['-hide_banner', '-i', output, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' });
        assert.equal(probe.status, 0, 'all output frames must decode');
        assert.match(probe.stderr, new RegExp(`Video: ${codec}`));
        assert.ok(probe.stderr.includes(`Duration: 00:00:${duration}`), 'duration is retained (with the explicit PAL speedup only for 25 fps)');
        assert.match(probe.stderr, /frame=\s*96\b/, 'all 96 source frames must remain');
    });
}
