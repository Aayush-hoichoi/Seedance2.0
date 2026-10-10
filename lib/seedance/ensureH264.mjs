// Server-only. BytePlus encodes some renders as H.265/HEVC — 2.0 at 4k, and
// Seedance 2.5 at EVERY resolution (probed 2026-09-23: 1080p output is hevc
// Rext, yuv444p10le — 10-bit 4:4:4). Editing tools (Nuke especially) can't
// open those — they show "Video Codec: Unknown". Every download flows through
// /api/seedance/download, so this is the one place to fix it: probe the file,
// and re-encode to H.264 only when it isn't already.
// The buffered compatibility helpers can return the original on failure.
// Explicit streamed conversions reject failures instead of substituting files.

import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

// Only mp4-family names — a .webm rewrapped as mp4 would lie about itself.
const VIDEO_NAME_RE = /\.(mp4|mov|m4v)$/i;

function run(args, timeoutMs) {
    return new Promise((resolve) => {
        const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        p.stderr.on('data', (d) => { stderr += d; });
        const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
        p.on('error', () => { clearTimeout(t); resolve({ code: -1, stderr }); });
        p.on('close', (code) => { clearTimeout(t); resolve({ code, stderr }); });
    });
}

// `ffmpeg -i file` with no output exits non-zero but still prints the stream
// info we need on stderr ("Video: hevc (Main) ...").
async function videoCodec(file) {
    const { stderr } = await run(['-hide_banner', '-i', file], 30_000);
    const m = /Video:\s*([a-z0-9_]+)/i.exec(stderr);
    return m ? m[1].toLowerCase() : null;
}

// mp4 → mov container remux (codecs copied, so lossless and near-instant).
// Returns the mov bytes, or null when conversion isn't possible (no ffmpeg,
// not an mp4 name, ffmpeg error) — the caller keeps the original bytes/name.
export async function remuxToMov(buf, name) {
    if (!ffmpegPath || !/\.(mp4|m4v)$/i.test(name || '')) return null;
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'mov-'));
        const src = join(dir, 'in.mp4');
        const out = join(dir, 'out.mov');
        await writeFile(src, buf);
        const { code } = await run(['-y', '-i', src, '-c', 'copy', out], 120_000);
        if (code !== 0) return null;
        const mov = await readFile(out);
        return mov.length ? mov : null;
    } catch {
        return null;
    } finally {
        if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// buf in → buf out. H.264 (or non-video, or anything that goes wrong) passes
// through untouched; everything else is re-encoded to H.264/yuv420p + AAC.
// ponytail: transcodes on every download of the same asset — cache the H.264
// copy in the TOS archive if 4k download volume ever makes this hurt.
export async function ensureH264(buf, name) {
    if (!ffmpegPath || !VIDEO_NAME_RE.test(name || '')) return buf;
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'h264-'));
        const src = join(dir, 'in.mp4');
        await writeFile(src, buf);
        const codec = await videoCodec(src);
        if (!codec || codec === 'h264') return buf;
        const out = join(dir, 'out.mp4');
        const { code } = await run([
            // 4K HEVC 4:4:4 frame buffers otherwise exceed a 2 GB function.
            '-y', '-threads', '2', '-filter_threads', '2', '-i', src,
            '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            out,
        ], 240_000);
        if (code !== 0) return buf;
        const fixed = await readFile(out);
        return fixed.length ? fixed : buf;
    } catch {
        return buf;
    } finally {
        if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// buf in → ProRes 4444 .mov bytes, or null on any failure (caller keeps the
// original). ProRes 4444 preserves Seedance 2.5's native 10-bit 4:4:4 and
// opens in Nuke/Resolve/Premiere — the only delivery that keeps both.
// ponytail: output is buffered in memory and runs ~30 MB/s of video (a 30s
// clip ≈ 850 MB) — switch to a streamed response like transcodeUrlToQuickTime
// if long-clip ProRes downloads ever hit serverless memory limits.
export async function transcodeToProRes(buf, name) {
    if (!ffmpegPath || !VIDEO_NAME_RE.test(name || '')) return null;
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'prores-'));
        const src = join(dir, 'in.mp4');
        const out = join(dir, 'out.mov');
        await writeFile(src, buf);
        const { code } = await run([
            '-y', '-threads', '2', '-filter_threads', '2', '-i', src,
            '-c:v', 'prores_ks', '-threads', '2', '-profile:v', '4', '-pix_fmt', 'yuv444p10le', '-vendor', 'apl0',
            '-c:a', 'pcm_s16le',
            out,
        ], 240_000);
        if (code !== 0) return null;
        const mov = await readFile(out);
        return mov.length ? mov : null;
    } catch {
        return null;
    } finally {
        if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// Stream a conversion while withholding successful EOF until the encoder has
// exited and the full source duration was converted. FFmpeg ordinarily exits
// zero after a short HTTP body, leaving a valid-looking but incomplete MOV.
function streamConversion(url, encoderArgs, label) {
    const output = new PassThrough();
    const child = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'info', '-nostats', '-xerror',
        '-threads', '2', '-filter_threads', '2', '-i', url,
        '-map', '0:v:0', '-map', '0:a:0?', ...encoderArgs,
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-progress', 'pipe:3', '-f', 'mov', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const done = new Promise((resolve) => child.once('close', resolve));
    let stderr = '';
    let sourceDuration = null;
    let outputDuration = 0;
    let progress = '';
    child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-16_384);
        if (sourceDuration === null) {
            const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
            if (duration) sourceDuration = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
        }
    });
    child.stdio[3].on('data', (chunk) => {
        progress += String(chunk);
        const lines = progress.split('\n');
        progress = lines.pop().slice(-1024);
        for (const line of lines) {
            const match = /^out_time_us=(\d+)$/.exec(line.trim());
            if (match) outputDuration = Math.max(outputDuration, Number(match[1]) / 1_000_000);
        }
    });
    const cancel = () => {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL');
    };
    // Never return stderr: it includes signed source URLs and credentials.
    const fail = (incomplete = false) => output.destroy(new Error(incomplete
        ? `${label} conversion failed: the source video could not be read completely. Please retry the download.`
        : `${label} conversion failed. Please retry the download.`));
    const timeout = setTimeout(() => { fail(); cancel(); }, 285_000);
    child.stdout.pipe(output, { end: false });
    child.stdout.once('error', () => fail());
    child.once('error', () => fail());
    child.once('close', (code) => {
        clearTimeout(timeout);
        // Container duration can differ slightly from decoded audio/video due
        // to codec padding. A quarter-second tolerance covers that rounding,
        // while rejecting the multi-second losses of a truncated response.
        // Sources without duration metadata can only use the strict decoder
        // error/exit checks; their original length cannot be inferred here.
        const incomplete = sourceDuration !== null && sourceDuration - outputDuration > 0.25;
        if (code === 0 && !incomplete) output.end();
        else fail(incomplete || /premature|Input\/output error|Error demuxing/i.test(stderr));
    });
    output.once('close', cancel);
    return { stream: output, cancel, done };
}

// ProRes output is much larger than its source. Stream both sides, and bound
// decoder/filter/encoder threads so frame buffers fit the server memory limit.
export function transcodeUrlToProRes(url) {
    if (!ffmpegPath || typeof url !== 'string' || !url) return null;
    return streamConversion(url, [
        '-c:v', 'prores_ks', '-threads', '2', '-profile:v', '4',
        '-pix_fmt', 'yuv444p10le', '-vendor', 'apl0', '-c:a', 'pcm_s16le',
    ], 'ProRes MOV');
}

// buf in → H.264 mp4 retimed to targetFps via the broadcast-standard speedup
// (same frames shown at the new rate — 24→25 plays ~4% faster, audio pitched
// with it, exactly how PAL delivery of 24fps material works). Returns null on
// failure so the caller can fall back to the unretimed file.
export async function retimeToFps(buf, name, targetFps = 25) {
    if (!ffmpegPath || !VIDEO_NAME_RE.test(name || '')) return null;
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'fps-'));
        const src = join(dir, 'in.mp4');
        const out = join(dir, 'out.mp4');
        await writeFile(src, buf);
        const { stderr } = await run(['-hide_banner', '-i', src], 30_000);
        const sourceFps = Number(/(\d+(?:\.\d+)?)\s*fps/i.exec(stderr)?.[1]);
        if (!Number.isFinite(sourceFps) || sourceFps <= 0 || sourceFps === targetFps) return null;
        const { code } = await run([
            '-y', '-threads', '2', '-filter_threads', '2', '-i', src,
            '-vf', `setpts=${sourceFps}/${targetFps}*PTS`, '-r', String(targetFps),
            '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-af', `atempo=${targetFps}/${sourceFps}`,
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            out,
        ], 240_000);
        if (code !== 0) return null;
        const fixed = await readFile(out);
        return fixed.length ? fixed : null;
    } catch {
        return null;
    } finally {
        if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// Stream a large remote video through an H.264 QuickTime conversion. EXR
// outputs can be over 1 GB, so buffering the whole file in the download route
// is unsafe. The source is read by ffmpeg directly and the converted MOV is
// streamed to the browser as it is produced.
export function transcodeUrlToQuickTime(url) {
    if (!ffmpegPath || typeof url !== 'string' || !url) return null;
    return streamConversion(url, [
        '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast',
        '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    ], 'QuickTime MOV');
}
