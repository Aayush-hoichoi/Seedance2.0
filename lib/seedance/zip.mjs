// Minimal, dependency-free ZIP writer (STORE method — no compression).
//
// Why hand-rolled: the only zip lib physically present (`archiver`) is a
// transitive dep, and an `npm install` in this submodule-workspace monorepo is
// risky. Videos (mp4) are already compressed, so STORE (method 0) is the right
// choice anyway — it just frames the bytes, no CPU spent deflating.
//
// `.mjs` on purpose: the repo has no `type:module`, so a plain `.js` lib would
// be parsed as CommonJS by raw Node and couldn't be unit-tested. `.mjs` is ESM
// for both Next's bundler and `node --test`. See tests/zip.test.mjs.
//
// Produces a standard PKZIP archive: per-entry [local header + data], then the
// central directory, then the end-of-central-directory record.

// Precomputed CRC-32 (IEEE 802.3) table — required by the zip format per entry.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// JS Date → packed MS-DOS time/date fields (2-second resolution, year ≥ 1980).
export function dosDateTime(date) {
    const d = date instanceof Date ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800; // names are UTF-8 (general purpose bit 11)

function localFileHeader(nameBuf, crc, size, dosTime, dosDate) {
    const h = Buffer.alloc(30 + nameBuf.length);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(20, 4); // version needed to extract
    h.writeUInt16LE(FLAG_UTF8, 6);
    h.writeUInt16LE(0, 8); // method 0 = store
    h.writeUInt16LE(dosTime, 10);
    h.writeUInt16LE(dosDate, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(size, 18); // compressed size (== uncompressed for store)
    h.writeUInt32LE(size, 22); // uncompressed size
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(h, 30);
    return h;
}

function centralDirHeader(nameBuf, crc, size, offset, dosTime, dosDate) {
    const c = Buffer.alloc(46 + nameBuf.length);
    c.writeUInt32LE(SIG_CENTRAL, 0);
    c.writeUInt16LE(20, 4); // version made by
    c.writeUInt16LE(20, 6); // version needed
    c.writeUInt16LE(FLAG_UTF8, 8);
    c.writeUInt16LE(0, 10); // method
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(size, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30); // extra
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk number start
    c.writeUInt16LE(0, 36); // internal attrs
    c.writeUInt32LE(0, 38); // external attrs
    c.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuf.copy(c, 46);
    return c;
}

function endOfCentralDir(count, cdSize, cdOffset) {
    const e = Buffer.alloc(22);
    e.writeUInt32LE(SIG_EOCD, 0);
    e.writeUInt16LE(0, 4); // this disk
    e.writeUInt16LE(0, 6); // disk with central dir
    e.writeUInt16LE(count, 8); // entries on this disk
    e.writeUInt16LE(count, 10); // total entries
    e.writeUInt32LE(cdSize, 12); // size of the central directory
    e.writeUInt32LE(cdOffset, 16); // offset of central directory from start
    e.writeUInt16LE(0, 20); // comment length
    return e;
}

// De-duplicate names within one archive ("clip.mp4" → "clip (2).mp4"); also
// strip path separators so a name can never escape the archive root.
function uniqueName(name, used) {
    let base = (name && String(name).trim()) || 'video.mp4';
    base = base.replace(/[/\\]+/g, '_');
    if (!used.has(base)) { used.add(base); return base; }
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let i = 2;
    let cand;
    do { cand = `${stem} (${i})${ext}`; i += 1; } while (used.has(cand));
    used.add(cand);
    return cand;
}

// Stream a zip as a sequence of Buffers. `entries` is any (async) iterable of
// { name, data: Buffer, date? }. Entries whose data is missing are skipped, so
// one failed download never aborts the whole archive. Memory stays flat: only
// one entry's bytes are held at a time (the caller fetches lazily).
export async function* zipStream(entries) {
    const central = [];
    const used = new Set();
    let offset = 0;
    for await (const entry of entries) {
        if (!entry || !entry.data || !entry.data.length) continue;
        const nameBuf = Buffer.from(uniqueName(entry.name, used), 'utf8');
        const crc = crc32(entry.data);
        const { dosTime, dosDate } = dosDateTime(entry.date);
        const lh = localFileHeader(nameBuf, crc, entry.data.length, dosTime, dosDate);
        yield lh;
        yield entry.data;
        central.push({ nameBuf, crc, size: entry.data.length, offset, dosTime, dosDate });
        offset += lh.length + entry.data.length;
    }
    let cdSize = 0;
    for (const c of central) {
        const cd = centralDirHeader(c.nameBuf, c.crc, c.size, c.offset, c.dosTime, c.dosDate);
        cdSize += cd.length;
        yield cd;
    }
    yield endOfCentralDir(central.length, cdSize, offset);
}

// Convenience: assemble a whole zip into one Buffer (used by tests / small sets).
export async function buildZip(entries) {
    const chunks = [];
    for await (const chunk of zipStream(toAsync(entries))) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function* toAsync(iterable) {
    for (const item of iterable) yield item;
}
