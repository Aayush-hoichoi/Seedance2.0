// Server-only. BytePlus encodes 4k renders as H.265/HEVC, which editing tools
// (Nuke especially) can't open — they show "Video Codec: Unknown". Every
// download flows through /api/seedance/download, so this is the one place to
// fix it: probe the file, and re-encode to H.264 only when it isn't already.
// Any failure returns the original bytes — a file that plays in VLC beats a
// failed download.

import { spawn } from 'node:child_process';
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
            '-y', '-i', src,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
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
