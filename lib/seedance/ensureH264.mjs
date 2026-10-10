// Server-only. BytePlus encodes some renders as H.265/HEVC — 2.0 at 4k, and
// Seedance 2.5 at EVERY resolution (probed 2026-09-23: 1080p output is hevc
// Rext, yuv444p10le — 10-bit 4:4:4). Editing tools (Nuke especially) can't
// open those — they show "Video Codec: Unknown". Every download flows through
// /api/seedance/download, so this is the one place to fix it: probe the file,
// and re-encode to H.264 only when it isn't already.
// Requested H.264/MOV conversions reject failures instead of substituting an
// unreadable file or an original encoded with a different codec.

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
        const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let duration = null;
        let outputDuration = 0;
        let outputTimeSeen = false;
        let frames = null;
        let progress = '';
        p.stderr.on('data', (d) => {
            stderr = (stderr + d).slice(-16_384);
            if (duration === null) {
                const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
                if (match) duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
            }
        });
        p.stdout.on('data', (chunk) => {
            progress += String(chunk);
            const lines = progress.split('\n');
            progress = lines.pop().slice(-1024);
            for (const line of lines) {
                const time = /^out_time_us=\s*(\d+)$/.exec(line.trim());
                const frame = /^frame=\s*(\d+)$/.exec(line.trim());
                if (time) {
                    outputTimeSeen = true;
                    outputDuration = Math.max(outputDuration, Number(time[1]) / 1_000_000);
                }
                if (frame) frames = Math.max(frames ?? 0, Number(frame[1]));
            }
        });
        const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
        p.on('error', () => { clearTimeout(t); resolve({ code: -1, stderr, duration, outputDuration, outputTimeSeen, frames }); });
        p.on('close', (code) => { clearTimeout(t); resolve({ code, stderr, duration, outputDuration, outputTimeSeen, frames }); });
    });
}

// `ffmpeg -i file` with no output exits non-zero but still prints the stream
// info we need on stderr ("Video: hevc (Main) ...").
// MP4/MOV track duration uses the movie timescale and includes edit lists.
// The container duration may instead be a longer audio tail; mdhd describes
// underlying media and can overstate an edited video track's playback length.
function videoTrackDuration(buffer) {
    function boxes(start, end) {
        const result = [];
        for (let offset = start; offset + 8 <= end;) {
            let size = buffer.readUInt32BE(offset);
            let header = 8;
            if (size === 1) {
                if (offset + 16 > end) break;
                size = Number(buffer.readBigUInt64BE(offset + 8));
                header = 16;
            } else if (size === 0) size = end - offset;
            if (!Number.isSafeInteger(size) || size < header || offset + size > end) break;
            result.push({ type: buffer.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + size });
            offset += size;
        }
        return result;
    }
    const children = (box) => box ? boxes(box.start, box.end) : [];
    const movie = boxes(0, buffer.length).find((box) => box.type === 'moov');
    const tracks = children(movie);
    const mvhd = tracks.find((box) => box.type === 'mvhd');
    if (!mvhd || mvhd.end - mvhd.start < 4) return null;
    const movieVersion = buffer[mvhd.start];
    if (movieVersion > 1) return null;
    const timescaleOffset = mvhd.start + (movieVersion === 1 ? 20 : 12);
    if (timescaleOffset + 4 > mvhd.end) return null;
    const timescale = buffer.readUInt32BE(timescaleOffset);
    if (!timescale) return null;
    for (const track of tracks.filter((box) => box.type === 'trak')) {
        const contents = children(track);
        const handler = children(contents.find((box) => box.type === 'mdia')).find((box) => box.type === 'hdlr');
        if (!handler || handler.start + 12 > handler.end || buffer.toString('ascii', handler.start + 8, handler.start + 12) !== 'vide') continue;
        const tkhd = contents.find((box) => box.type === 'tkhd');
        if (!tkhd || tkhd.end - tkhd.start < 4 || buffer[tkhd.start] > 1) return null;
        const version = buffer[tkhd.start];
        const offset = tkhd.start + (version === 1 ? 28 : 20);
        if (offset + (version === 1 ? 8 : 4) > tkhd.end) return null;
        const ticks = version === 1 ? Number(buffer.readBigUInt64BE(offset)) : buffer.readUInt32BE(offset);
        if (!Number.isSafeInteger(ticks) || ticks <= 0 || ticks === 0xffffffff) return null;
        // FFmpeg normalizes an initial empty edit (a delayed track start) out
        // of its progress timeline. Keep all subsequent playback edits.
        const elst = children(contents.find((box) => box.type === 'edts')).find((box) => box.type === 'elst');
        let leadingEmptyTicks = 0;
        if (elst) {
            if (elst.start + 8 > elst.end || buffer[elst.start] > 1) return null;
            const editVersion = buffer[elst.start];
            const entrySize = editVersion === 1 ? 20 : 12;
            const entryCount = buffer.readUInt32BE(elst.start + 4);
            if (entryCount > Math.floor((elst.end - elst.start - 8) / entrySize)) return null;
            for (let index = 0; index < entryCount; index++) {
                const entry = elst.start + 8 + index * entrySize;
                const mediaTime = editVersion === 1 ? buffer.readBigInt64BE(entry + 8) : BigInt(buffer.readInt32BE(entry + 4));
                if (mediaTime !== -1n) break;
                leadingEmptyTicks += editVersion === 1 ? Number(buffer.readBigUInt64BE(entry)) : buffer.readUInt32BE(entry);
                if (!Number.isSafeInteger(leadingEmptyTicks) || leadingEmptyTicks >= ticks) return null;
            }
        }
        return (ticks - leadingEmptyTicks) / timescale;
    }
    return null;
}

async function videoInfo(file, buffer) {
    const { stderr, duration } = await run(['-hide_banner', '-i', file], 30_000);
    const m = /Video:\s*([a-z0-9_]+)/i.exec(stderr);
    const videoDuration = videoTrackDuration(buffer) ?? (/Audio:/i.test(stderr) ? null : duration);
    return { codec: m ? m[1].toLowerCase() : null, duration: videoDuration, fps: Number(/(\d+(?:\.\d+)?)\s*fps/i.exec(stderr)?.[1]) };
}

function conversionError(label) {
    return new Error(`${label} conversion failed: the complete video could not be prepared. Please retry the download.`);
}

function tempoFilters(ratio) {
    const filters = [];
    // atempo cannot slow below 0.5 in one stage (60→25 fps needs 0.4167).
    // Stay within 0.5–2 for every stage to retain all audio samples.
    while (ratio < 0.5) { filters.push('atempo=0.5'); ratio /= 0.5; }
    while (ratio > 2) { filters.push('atempo=2'); ratio /= 2; }
    filters.push(`atempo=${ratio}`);
    return filters.join(',');
}

// Reading video packets without decoding is cheap, including for H.264 inputs
// that need no re-encode. It catches incomplete pass-through files and checks
// the video timeline independently, so a longer audio track cannot hide loss.
async function validateVideo(file, expectedDuration) {
    const result = await run([
        '-hide_banner', '-loglevel', 'error', '-nostats', '-xerror', '-i', file,
        '-map', '0:v:0', '-c', 'copy', '-progress', 'pipe:1', '-f', 'null', '-',
    ], 30_000);
    // FFmpeg 6.1 omits frame counts for stream copy. A numeric mux timestamp
    // still proves packets were read, including a single frame at time zero.
    const noPackets = result.frames === null ? !result.outputTimeSeen : result.frames === 0;
    if (result.code !== 0 || noPackets
        || (expectedDuration !== null && expectedDuration - result.outputDuration > 0.25)) {
        console.warn('[video-validation]', JSON.stringify({
            exitCode: result.code, expectedDuration, outputDuration: result.outputDuration,
            frames: result.frames, outputTimeSeen: result.outputTimeSeen,
        }));
        throw conversionError('Video');
    }
}

// mp4 → mov container remux (codecs copied, so lossless and near-instant).
// Non-MP4 names need no remux. Failed requested remuxes must not masquerade as
// successful MOV downloads by returning the original file.
export async function remuxToMov(buf, name) {
    if (!/\.(mp4|m4v)$/i.test(name || '')) return null;
    if (!ffmpegPath) throw conversionError('MOV');
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'mov-'));
        const src = join(dir, 'in.mp4');
        const out = join(dir, 'out.mov');
        await writeFile(src, buf);
        const source = await videoInfo(src, buf);
        if (!source.codec) throw conversionError('MOV');
        const { code } = await run(['-y', '-xerror', '-i', src, '-c', 'copy', out], 120_000);
        if (code !== 0) throw conversionError('MOV');
        await validateVideo(out, source.duration);
        const mov = await readFile(out);
        if (!mov.length) throw conversionError('MOV');
        return mov;
    } catch {
        throw conversionError('MOV');
    } finally {
        if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// Valid H.264 and non-video inputs pass through untouched; other video is
// re-encoded to H.264/yuv420p + AAC. Video failures reject explicitly.
// ponytail: transcodes on every download of the same asset — cache the H.264
// copy in the TOS archive if 4k download volume ever makes this hurt.
export async function ensureH264(buf, name) {
    if (!VIDEO_NAME_RE.test(name || '')) return buf;
    if (!ffmpegPath) throw conversionError('H.264');
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'h264-'));
        const src = join(dir, 'in.mp4');
        await writeFile(src, buf);
        const source = await videoInfo(src, buf);
        if (!source.codec) throw conversionError('H.264');
        if (source.codec === 'h264') {
            await validateVideo(src, source.duration);
            return buf;
        }
        const out = join(dir, 'out.mp4');
        const { code } = await run([
            // 4K HEVC 4:4:4 frame buffers otherwise exceed a 2 GB function.
            '-y', '-xerror', '-threads', '2', '-filter_threads', '2', '-i', src,
            '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            out,
        ], 240_000);
        if (code !== 0) throw conversionError('H.264');
        await validateVideo(out, source.duration);
        const fixed = await readFile(out);
        if (!fixed.length) throw conversionError('H.264');
        return fixed;
    } catch {
        throw conversionError('H.264');
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
            '-c:v', 'prores_ks', '-threads', '2', '-profile:v', '4', '-qscale:v', '4', '-pix_fmt', 'yuv444p10le', '-vendor', 'apl0',
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
    const startedAt = Date.now();
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
    let outputBytes = 0;
    let progressSeen = false;
    let timedOut = false;
    let cancelRequested = false;
    let cancelReason = null;
    let spawnErrorCode = null;
    let pipeError = false;
    let progress = '';
    child.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-16_384);
        if (sourceDuration === null) {
            const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
            if (duration) sourceDuration = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
        }
    });
    child.stdio[3].on('data', (chunk) => {
        progressSeen = true;
        progress += String(chunk);
        const lines = progress.split('\n');
        progress = lines.pop().slice(-1024);
        for (const line of lines) {
            const match = /^out_time_us=(\d+)$/.exec(line.trim());
            if (match) outputDuration = Math.max(outputDuration, Number(match[1]) / 1_000_000);
        }
    });
    const cancel = (reason = 'requested') => {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null && !child.killed) {
            cancelRequested = true;
            cancelReason = ['requested', 'timeout', 'output_closed'].includes(reason) ? reason : 'requested';
            child.kill('SIGKILL');
        }
    };
    // Never return stderr: it includes signed source URLs and credentials.
    const fail = (incomplete = false) => output.destroy(new Error(incomplete
        ? `${label} conversion failed: the source video could not be read completely. Please retry the download.`
        : `${label} conversion failed. Please retry the download.`));
    const timeout = setTimeout(() => { timedOut = true; fail(); cancel('timeout'); }, 285_000);
    child.stdout.pipe(output, { end: false });
    child.stdout.on('data', (chunk) => { outputBytes += chunk.length; });
    child.stdout.once('error', () => { pipeError = true; fail(); });
    child.stdio[3].once('error', () => { pipeError = true; fail(); });
    child.once('error', (error) => {
        // Only a fixed set of OS error codes is safe to log, never message/path.
        spawnErrorCode = ['ENOENT', 'EACCES', 'ENOMEM', 'EAGAIN', 'EMFILE', 'ENFILE'].includes(error.code) ? error.code : 'OTHER';
        fail();
    });
    child.once('close', (code, signal) => {
        clearTimeout(timeout);
        // Container duration can differ slightly from decoded audio/video due
        // to codec padding. A quarter-second tolerance covers that rounding,
        // while rejecting the multi-second losses of a truncated response.
        // Sources without duration metadata can only use the strict decoder
        // error/exit checks; their original length cannot be inferred here.
        const incomplete = sourceDuration !== null && sourceDuration - outputDuration > 0.25;
        const succeeded = code === 0 && !incomplete;
        // Record encoder completion separately from HTTP delivery. This also
        // distinguishes a downstream transfer failure from an encoder failure.
        // Never expose the bearer URL FFmpeg prints: only fixed values/numbers.
        const categories = Object.entries({
            source_io: /premature|Input\/output error|Error demuxing/i,
            network: /Connection (?:reset|refused)|timed out|Network is unreachable|Failed to resolve|Server returned/i,
            tls: /TLS|SSL|certificate/i,
            memory: /Cannot allocate memory|out of memory|malloc.*fail/i,
            codec: /Unknown encoder|Encoder .*not found|Error while opening encoder|Error initializing output stream|Error while decoding/i,
            unsupported_option: /Unrecognized option|Option .*not found|Invalid argument/i,
            pipe: /Bad file descriptor|Broken pipe/i,
            invalid_media: /Invalid data found|moov atom not found|could not find codec parameters/i,
        }).filter(([, pattern]) => pattern.test(stderr)).map(([category]) => category);
        const httpStatus = Number(/(?:HTTP error|Server returned)\s+(\d{3})/.exec(stderr)?.[1]) || null;
        (succeeded ? console.info : console.error)('[video-conversion]', JSON.stringify({
            format: label, succeeded, exitCode: code, signal, elapsedMs: Date.now() - startedAt,
            sourceDuration, outputDuration, outputBytes, progressSeen, incomplete,
            cancelRequested, cancelReason, timedOut, spawnErrorCode, pipeError, categories, httpStatus,
            platform: process.platform, arch: process.arch,
            rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        }));
        if (succeeded) output.end();
        else {
            fail(incomplete || /premature|Input\/output error|Error demuxing/i.test(stderr));
        }
    });
    output.once('close', () => cancel('output_closed'));
    return { stream: output, cancel, done };
}

// ProRes output is much larger than its source. Stream both sides, and bound
// decoder/filter/encoder threads so frame buffers fit the server memory limit.
export function transcodeUrlToProRes(url) {
    if (!ffmpegPath || typeof url !== 'string' || !url) return null;
    return streamConversion(url, [
        '-c:v', 'prores_ks', '-threads', '2', '-profile:v', '4', '-qscale:v', '4',
        '-pix_fmt', 'yuv444p10le', '-vendor', 'apl0', '-c:a', 'pcm_s16le',
    ], 'ProRes MOV');
}

// buf in → H.264 mp4 retimed to targetFps via the broadcast-standard speedup
// (same frames shown at the new rate — 24→25 plays ~4% faster, audio pitched
// with it, exactly how PAL delivery of 24fps material works). Returns null only
// when no retime is needed; requested retime failures reject explicitly.
export async function retimeToFps(buf, name, targetFps = 25) {
    if (!VIDEO_NAME_RE.test(name || '')) return null;
    if (!ffmpegPath) throw conversionError('25 fps H.264');
    let dir;
    try {
        dir = await mkdtemp(join(tmpdir(), 'fps-'));
        const src = join(dir, 'in.mp4');
        const out = join(dir, 'out.mp4');
        await writeFile(src, buf);
        const source = await videoInfo(src, buf);
        const sourceFps = source.fps;
        if (!source.codec || !Number.isFinite(sourceFps) || sourceFps <= 0
            || !Number.isFinite(targetFps) || targetFps <= 0) throw conversionError('25 fps H.264');
        if (sourceFps === targetFps) {
            await validateVideo(src, source.duration);
            return null;
        }
        const { code } = await run([
            '-y', '-xerror', '-threads', '2', '-filter_threads', '2', '-i', src,
            '-vf', `setpts=${sourceFps}/${targetFps}*PTS`, '-r', String(targetFps),
            '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-af', tempoFilters(targetFps / sourceFps),
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            out,
        ], 240_000);
        if (code !== 0) throw conversionError('25 fps H.264');
        await validateVideo(out, source.duration === null ? null : source.duration * sourceFps / targetFps);
        const fixed = await readFile(out);
        if (!fixed.length) throw conversionError('25 fps H.264');
        return fixed;
    } catch {
        throw conversionError('25 fps H.264');
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
