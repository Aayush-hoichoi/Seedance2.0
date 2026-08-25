// A minimal, read-only .xlsx reader — zip + XML, no dependencies.
//
// It exists for one job: scripts/ledger-verify.mjs reconciles the rebuilt
// ledger against the two hand-built workbooks. Those files are a known-good
// 9,133-row answer, which makes them a free correctness oracle for the
// generation_ledger view — and one that expires as soon as the data moves on,
// so it is worth a little parsing code to use it while it is still valid.
//
// Deliberately partial: no styles, no formulas, no dates-as-serials. Every
// cell comes back as the string Excel stored, which is exactly what a
// cell-for-cell comparison against the sheet wants.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEndOfCentralDirectory(buf) {
    // The EOCD is last, but a trailing comment (max 64KB) can follow it.
    const start = Math.max(0, buf.length - 65_557);
    for (let i = buf.length - 22; i >= start; i -= 1) {
        if (buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    throw new Error('not a zip file (no end-of-central-directory record)');
}

function readEntries(buf) {
    const eocd = findEndOfCentralDirectory(buf);
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = new Map();

    for (let i = 0; i < count; i += 1) {
        if (buf.readUInt32LE(p) !== CENTRAL_SIG) break;
        const method = buf.readUInt16LE(p + 10);
        const compressedSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        entries.set(name, { method, compressedSize, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function readFile(buf, entry) {
    if (buf.readUInt32LE(entry.localOffset) !== LOCAL_SIG) throw new Error('corrupt zip entry');
    const nameLen = buf.readUInt16LE(entry.localOffset + 26);
    const extraLen = buf.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${entry.method}`);
}

function decodeXmlText(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, '&'); // last, so &amp;lt; survives as &lt;
}

// <si> may hold one <t> or several inside <r> runs; concatenate them all.
function parseSharedStrings(xml) {
    if (!xml) return [];
    const out = [];
    for (const [, si] of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
        let text = '';
        for (const [, t] of si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXmlText(t);
        out.push(text);
    }
    return out;
}

// "BC" → 54. Column letters are the only part of a cell ref we need.
function columnIndex(ref) {
    const letters = /^([A-Z]+)/.exec(ref || '');
    if (!letters) return 0;
    let n = 0;
    for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

function parseSheet(xml, shared) {
    const rows = [];
    for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = new Map();
        // Two forms: <c …>…</c> and the self-closing <c …/> some writers emit
        // for an empty cell. Matching only the first is not merely lossy — the
        // pattern would run past a self-closing tag to the NEXT cell's </c>,
        // attaching that cell's value to this cell's reference and shifting
        // every remaining column in the row by one.
        for (const cell of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = cell[1];
            const inner = cell[2] ?? '';
            const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] || '';
            const type = /t="([^"]+)"/.exec(attrs)?.[1] || 'n';
            let value = '';
            if (type === 's') {
                const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
                value = shared[idx] ?? '';
            } else if (type === 'inlineStr') {
                for (const [, t] of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) value += decodeXmlText(t);
            } else {
                value = decodeXmlText(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
            }
            cells.set(columnIndex(ref), value);
        }
        const width = cells.size ? Math.max(...cells.keys()) + 1 : 0;
        rows.push(Array.from({ length: width }, (_, i) => cells.get(i) ?? ''));
    }
    // Self-closing <row .../> holds no cells and is legitimately empty.
    return rows;
}

/**
 * Read one sheet from an .xlsx as an array of string arrays (row 0 = header).
 * Pass no sheetName for the first sheet in the workbook.
 */
export function readSheet(path, sheetName = null) {
    const buf = readFileSync(path);
    const entries = readEntries(buf);
    const text = (name) => (entries.has(name) ? readFile(buf, entries.get(name)).toString('utf8') : null);

    const shared = parseSharedStrings(text('xl/sharedStrings.xml'));
    const workbook = text('xl/workbook.xml') || '';
    const rels = text('xl/_rels/workbook.xml.rels') || '';

    const relTargets = new Map();
    for (const [, id, target] of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
        relTargets.set(id, target);
    }

    const sheets = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
        .map(([, name, rid]) => ({ name: decodeXmlText(name), target: relTargets.get(rid) || '' }));
    if (!sheets.length) throw new Error('no sheets found in workbook');

    const chosen = sheetName ? sheets.find((s) => s.name === sheetName) : sheets[0];
    if (!chosen) throw new Error(`sheet "${sheetName}" not found — have: ${sheets.map((s) => s.name).join(', ')}`);

    const path2 = chosen.target.startsWith('xl/') ? chosen.target : `xl/${chosen.target.replace(/^\/+/, '')}`;
    const sheetXml = text(path2);
    if (!sheetXml) throw new Error(`sheet part ${path2} missing from workbook`);
    return parseSheet(sheetXml, shared);
}

export function sheetNames(path) {
    const buf = readFileSync(path);
    const entries = readEntries(buf);
    const workbook = readFile(buf, entries.get('xl/workbook.xml')).toString('utf8');
    return [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map(([, name]) => decodeXmlText(name));
}
