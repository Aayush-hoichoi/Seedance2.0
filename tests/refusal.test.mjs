import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRefusal, isRefusal } from '../lib/openai/refusal.mjs';

test('detects the common GPT-4o refusal phrasings', () => {
    assert.equal(looksLikeRefusal("I'm sorry, I can't assist with that request."), true);
    assert.equal(looksLikeRefusal('I am sorry, but I cannot help with this.'), true);
    assert.equal(looksLikeRefusal("I'm unable to assist with that."), true);
    assert.equal(looksLikeRefusal('I must decline. This violates our content policy.'), true);
});

test('does not flag a real production brief (long, even if it mentions violence)', () => {
    const brief = [
        'SHOT BREAKDOWN — single continuous handheld take.',
        'Subject: the man from Image 1 in a black kurta walks forward with rage.',
        'He punches the man on the ground like Video 1; subtle blood splatter on his face.',
        'Camera: low angle, trembling handheld. Lighting: hard practical key.',
    ].join('\n').repeat(6); // make it clearly brief-length
    assert.ok(brief.length > 600);
    assert.equal(looksLikeRefusal(brief), false);
});

test('does not flag a short legit line that lacks refusal language', () => {
    assert.equal(looksLikeRefusal('The man walks forward and the camera follows.'), false);
});

test('length gate: a long text containing "I\'m sorry" in dialogue is not a refusal', () => {
    const t = `Dialogue: he whispers "I'm sorry" as the rain falls. ${'x'.repeat(700)}`;
    assert.equal(looksLikeRefusal(t), false);
});

test('handles non-strings and empties', () => {
    assert.equal(looksLikeRefusal(''), false);
    assert.equal(looksLikeRefusal(null), false);
    assert.equal(looksLikeRefusal(undefined), false);
    assert.equal(looksLikeRefusal(42), false);
});

test('isRefusal trusts finish_reason=content_filter regardless of text', () => {
    assert.equal(isRefusal({ text: 'a perfectly normal long brief...', finishReason: 'content_filter' }), true);
    assert.equal(isRefusal({ text: 'normal brief', finishReason: 'stop' }), false);
    assert.equal(isRefusal({ text: "I'm sorry, I can't assist with that.", finishReason: 'stop' }), true);
});
