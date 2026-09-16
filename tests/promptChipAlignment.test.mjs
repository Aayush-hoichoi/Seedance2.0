import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The prompt bar paints @Image1 chips in a mirror <div> behind a
// transparent-text <textarea>, held in register by copying scrollTop. Two
// browser facts break that, and both bit a user on a long prompt: the chips
// ended up a full line above the caret, and select-all revealed the textarea's
// own text on top of the backdrop — the prompt appeared to render twice.
//
//  1. A `white-space: pre-wrap` block DROPS a segment break at its end; a
//     textarea keeps it as a real empty line. Measured in Chrome with this
//     exact markup: prompt with no trailing newline → both scrollHeight 964;
//     with one trailing newline → textarea 986, mirror 964. Scrolled to the
//     bottom, `chip.scrollTop = ta.scrollTop` clamps at the mirror's smaller
//     max and the layers sit 23px — exactly one line — apart.
//  2. globals.css `::selection` sets a colour, which outranks the textarea's
//     `text-transparent` for selected text.

const src = readFileSync(new URL('../app/seedance/PromptBar.jsx', import.meta.url), 'utf8');

test('the chip backdrop ends with a newline sentinel, or it is a line short', () => {
    assert.match(src, /out\.push\(`\$\{text\.slice\(last\)\}\\n`\)/,
        'renderChips must append \\n — pre-wrap eats it, the textarea does not');
});

test('the textarea keeps its text invisible even when selected', () => {
    const ta = src.slice(src.indexOf('<textarea'), src.indexOf('</div>', src.indexOf('<textarea')));
    assert.match(ta, /\btext-transparent\b/);
    assert.match(ta, /\[&::selection\]:text-transparent/,
        'globals.css ::selection sets a colour and would paint this layer on select-all');
});

test('globals.css still has the ::selection colour the guard defends against', () => {
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
    assert.match(css, /::selection\s*\{[^}]*color:/,
        'if this rule ever goes away the [&::selection] guard above is dead weight');
});

test('both layers still share identical text metrics', () => {
    // Any divergence in font-size/leading/padding between the two re-opens the
    // drift by a different door, so pin the three that must match.
    const region = src.slice(src.indexOf('ref={chipRef}'), src.indexOf('</div>', src.indexOf('<textarea')));
    for (const cls of ['text-sm', 'pt-2', 'leading-relaxed', '[scrollbar-gutter:stable]']) {
        const hits = region.split(cls).length - 1;
        assert.equal(hits, 2, `${cls} must appear on BOTH the backdrop and the textarea`);
    }
});
