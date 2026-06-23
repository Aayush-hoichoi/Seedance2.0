import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, buildZip } from '../lib/seedance/zip.mjs';

// Parse a STORE-method zip back into { name -> data } by walking the central
// directory and reading each local entry. Lets us round-trip without `unzip`.
function readZip(buf) {
    assert.ok(buf.length >= 22, 'zip too short');
    const eocd = buf.length - 22;
    assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD signature');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    assert.equal(cdOffset + cdSize, eocd, 'central dir ends right before EOCD');

    const out = {};
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
        const crc = buf.readUInt32LE(p + 16);
        const size = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;

        // Follow the offset into the local entry and slice the stored bytes.
        assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(dataStart, dataStart + size);
        assert.equal(crc32(data), crc, `crc matches for ${name}`);
        out[name] = Buffer.from(data);
    }
    return { count, entries: out };
}

test('crc32 known vectors', () => {
    assert.equal(crc32(Buffer.from('')), 0);
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('buildZip round-trips a single entry', async () => {
    const data = Buffer.from('hello seedance', 'utf8');
    const zip = await buildZip([{ name: 'clip.mp4', data }]);
    const { count, entries } = readZip(zip);
    assert.equal(count, 1);
    assert.deepEqual(entries['clip.mp4'], data);
});

test('buildZip handles multiple entries, dedupes names, keeps utf8 names', async () => {
    const a = Buffer.from([0, 1, 2, 3, 255, 254]);
    const b = Buffer.from('second clip bytes');
    const c = Buffer.from('third');
    const zip = await buildZip([
        { name: 'clip.mp4', data: a },
        { name: 'clip.mp4', data: b }, // duplicate → "clip (2).mp4"
        { name: 'né-vidéo.mp4', data: c }, // non-ascii preserved
    ]);
    const { count, entries } = readZip(zip);
    assert.equal(count, 3);
    assert.deepEqual(entries['clip.mp4'], a);
    assert.deepEqual(entries['clip (2).mp4'], b);
    assert.deepEqual(entries['né-vidéo.mp4'], c);
});

test('buildZip strips path separators from names', async () => {
    const data = Buffer.from('x');
    const zip = await buildZip([{ name: '../../etc/passwd', data }]);
    const { entries } = readZip(zip);
    assert.ok(Object.keys(entries)[0].indexOf('/') === -1, 'no slashes in archived name');
});

test('buildZip skips entries without data and an all-empty set is a valid empty zip', async () => {
    const zip = await buildZip([{ name: 'a.mp4' }, { name: 'b.mp4', data: Buffer.alloc(0) }]);
    const { count } = readZip(zip);
    assert.equal(count, 0);
    assert.equal(zip.length, 22); // EOCD only
});
