// Write a .xlsx, dependency-free.
//
// An .xlsx is a zip of XML parts, so no spreadsheet library is needed — just a
// zip writer. This is the mirror of lib/ledger/xlsxRead.mjs: that one reads the
// workbooks you already have, this one produces the download.
//
// It reuses lib/seedance/zip.mjs's crc32 and dosDateTime but NOT its buildZip:
// that one deliberately flattens "/" to "_" so a media filename can never
// escape the archive root, and an xlsx is defined entirely by paths like
// xl/worksheets/sheet1.xml. Weakening that guard for every caller to serve this
// one would be the wrong trade, so the archive framing is rebuilt here instead.
// Entries are deflated — the XML is extremely repetitive, so a 9,000-row export
// compresses by roughly an order of magnitude.
//
// The sheet is deliberately minimal: one worksheet, inline strings, a frozen
// bold header row and an autofilter. No shared-string table (it saves bytes but
// costs a second pass and a whole index), no styles beyond the header, no
// formulas. This is a data export, not a document.

import { deflateRawSync } from 'node:zlib';
import { crc32, dosDateTime } from '../seedance/zip.mjs';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

// XML 1.0 forbids most control characters outright — they cannot be escaped,
// only removed. Prompts are free text pasted from anywhere, so this is not
// hypothetical: one stray byte would make the whole workbook unopenable.
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function esc(value) {
    return String(value)
        .replace(ILLEGAL_XML, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 0 → A, 25 → Z, 26 → AA … the 47th column is AU.
export function columnLetter(index) {
    let n = index + 1;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

// Numbers are written as numbers so Excel can sum a cost column without the
// user retyping it. Everything else — including anything that merely LOOKS
// numeric, like a task id — stays text.
function cell(ref, value, styleIndex) {
    const style = styleIndex ? ` s="${styleIndex}"` : '';
    // An empty cell is OMITTED, not written as <c r="L5"/>. Excel and the
    // reference workbooks both do this — a sheet is a sparse map keyed by cell
    // reference, not a dense grid — and it keeps a 47-column export from
    // carrying tens of thousands of empty elements.
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

// Excel refuses to open a workbook with more than 65,530 hyperlinks on a
// sheet. The video workbook carries 25,955, so the ceiling is real but not
// close; the guard exists because the ledger grows and a silently unopenable
// file is the worst possible failure for an export.
const MAX_HYPERLINKS_PER_SHEET = 65_530;

// `links` maps "column name" → (row) => url. A cell keeps its own display text
// and gains a hyperlink relationship, which is how the video workbook renders
// a filename that opens the asset.
function sheetXml(columns, rows, links) {
    const lastColumn = columnLetter(columns.length - 1);
    const linkColumns = links ? columns.map((name, i) => [name, i]).filter(([name]) => links[name]) : [];
    const hyperlinks = [];

    const parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`,
        // Freeze the header so 9,000 rows stay navigable.
        '<sheetViews><sheetView workbookViewId="0">',
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
        '</sheetView></sheetViews>',
        '<sheetFormatPr defaultRowHeight="15"/>',
        '<sheetData>',
        `<row r="1">${columns.map((name, i) => cell(`${columnLetter(i)}1`, name, 1)).join('')}</row>`,
    ];

    rows.forEach((row, r) => {
        const n = r + 2; // 1-based, and row 1 is the header
        const cells = columns.map((name, i) => cell(`${columnLetter(i)}${n}`, row[name])).join('');
        parts.push(`<row r="${n}">${cells}</row>`);

        for (const [name, i] of linkColumns) {
            if (hyperlinks.length >= MAX_HYPERLINKS_PER_SHEET) break;
            if (row[name] === '' || row[name] === null || row[name] === undefined) continue;
            const url = links[name](row);
            if (!url) continue;
            hyperlinks.push({ ref: `${columnLetter(i)}${n}`, url });
        }
    });

    parts.push('</sheetData>');
    parts.push(`<autoFilter ref="A1:${lastColumn}${rows.length + 1}"/>`);
    if (hyperlinks.length) {
        parts.push('<hyperlinks>');
        hyperlinks.forEach((h, i) => parts.push(`<hyperlink ref="${h.ref}" r:id="rId${i + 1}"/>`));
        parts.push('</hyperlinks>');
    }
    parts.push('</worksheet>');
    return { xml: parts.join(''), hyperlinks };
}

// External hyperlink targets live in the sheet's own rels part, marked
// TargetMode="External" — without that Excel treats them as internal paths and
// silently drops them.
function sheetRelsXml(hyperlinks) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<Relationships xmlns="${PKG_REL_NS}">`
        + hyperlinks.map((h, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL_NS}/hyperlink" Target="${esc(h.url)}" TargetMode="External"/>`).join('')
        + '</Relationships>';
}

// Two fonts (normal, bold) and two formats; the header uses index 1.
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<styleSheet xmlns="${MAIN_NS}">`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
    + '</styleSheet>';

/**
 * Build an .xlsx Buffer.
 *
 * @param columns  ordered column names — the header row and the cell order
 * @param rows     array of objects keyed by those column names
 * @param sheetName  worksheet tab name (Excel caps it at 31 chars)
 */
// Minimal zip writer that preserves paths. Deflated (method 8), UTF-8 names
// (flag bit 11), no zip64 — an xlsx of this size is nowhere near the 4 GB or
// 65,535-entry limits that would require it.
function zipParts(entries) {
    const { dosTime, dosDate } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const compressed = deflateRawSync(data, { level: 9 });
        const crc = crc32(data);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);      // version needed
        local.writeUInt16LE(0x0800, 6);  // UTF-8 filename
        local.writeUInt16LE(8, 8);       // deflate
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuf.copy(local, 30);

        chunks.push(local, compressed);
        central.push({ nameBuf, crc, compressedSize: compressed.length, size: data.length, offset });
        offset += local.length + compressed.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) {
        const cd = Buffer.alloc(46 + c.nameBuf.length);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);         // version made by
        cd.writeUInt16LE(20, 6);         // version needed
        cd.writeUInt16LE(0x0800, 8);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt16LE(dosTime, 12);
        cd.writeUInt16LE(dosDate, 14);
        cd.writeUInt32LE(c.crc, 16);
        cd.writeUInt32LE(c.compressedSize, 20);
        cd.writeUInt32LE(c.size, 24);
        cd.writeUInt16LE(c.nameBuf.length, 28);
        cd.writeUInt16LE(0, 30);         // extra
        cd.writeUInt16LE(0, 32);         // comment
        cd.writeUInt16LE(0, 34);         // disk
        cd.writeUInt16LE(0, 36);         // internal attrs
        cd.writeUInt32LE(0, 38);         // external attrs
        cd.writeUInt32LE(c.offset, 42);
        c.nameBuf.copy(cd, 46);
        chunks.push(cd);
        cdSize += cd.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    chunks.push(eocd);

    return Buffer.concat(chunks);
}

/**
 * Build a multi-sheet .xlsx Buffer.
 *
 * @param sheets  [{ name, columns, rows, links? }]
 *                links: { "Column name": (row) => url } — the cell keeps its
 *                display text and becomes clickable.
 *
 * Sheet names are capped at Excel's 31 characters and de-duplicated: two tabs
 * with the same name makes the file unopenable, and both workbooks have a
 * "Downloaded Only" and a "Reference Assets" tab, so collisions are plausible.
 */
export function buildXlsx({ sheets, columns, rows, sheetName = 'Sheet1' }) {
    // Single-sheet call signature kept so existing callers and tests still work.
    const list = sheets ?? [{ name: sheetName, columns, rows }];
    const used = new Set();
    const prepared = list.map((sheet, i) => {
        let name = String(sheet.name ?? `Sheet${i + 1}`).slice(0, 31);
        while (used.has(name)) name = `${name.slice(0, 28)}_${i + 1}`;
        used.add(name);
        const built = sheetXml(sheet.columns, sheet.rows ?? [], sheet.links);
        return { name, index: i + 1, ...built };
    });

    const file = (path, xml) => ({ name: path, data: Buffer.from(xml, 'utf8') });
    const parts = [
        file('[Content_Types].xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            + '<Default Extension="xml" ContentType="application/xml"/>'
            + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + prepared.map((s) => `<Override PartName="/xl/worksheets/sheet${s.index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
            + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + '</Types>'),
        file('_rels/.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + `<Relationships xmlns="${PKG_REL_NS}">`
            + `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>`
            + '</Relationships>'),
        file('xl/workbook.xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`
            + `<sheets>${prepared.map((s) => `<sheet name="${esc(s.name)}" sheetId="${s.index}" r:id="rId${s.index}"/>`).join('')}</sheets>`
            + '</workbook>'),
        file('xl/_rels/workbook.xml.rels',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + `<Relationships xmlns="${PKG_REL_NS}">`
            + prepared.map((s) => `<Relationship Id="rId${s.index}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${s.index}.xml"/>`).join('')
            + `<Relationship Id="rId${prepared.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`
            + '</Relationships>'),
        file('xl/styles.xml', STYLES_XML),
    ];

    for (const s of prepared) {
        parts.push(file(`xl/worksheets/sheet${s.index}.xml`, s.xml));
        if (s.hyperlinks.length) {
            parts.push(file(`xl/worksheets/_rels/sheet${s.index}.xml.rels`, sheetRelsXml(s.hyperlinks)));
        }
    }

    return zipParts(parts);
}
