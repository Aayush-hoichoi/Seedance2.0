// The download proxy serves both videos and images, so the saved filename must
// take its extension from the asset itself — the old behaviour forced .mp4 onto
// everything, which meant a downloaded image wouldn't open.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extFromUrl, safeName } from '../lib/seedance/downloadName.mjs';

const TOS = 'https://seedance-studio-assets.tos-ap-southeast-1.bytepluses.com';

test('extension comes from the asset URL, not a hardcoded .mp4', () => {
    assert.equal(extFromUrl(`${TOS}/images/job-12-0.png?X-Tos-Signature=abc`), '.png');
    assert.equal(extFromUrl(`${TOS}/images/job-12-0.JPEG`), '.jpeg');
    assert.equal(extFromUrl(`${TOS}/videos/task-9.mp4?expires=1`), '.mp4');
    assert.equal(extFromUrl(`${TOS}/videos/no-extension`), '.mp4'); // videos are the common case
    assert.equal(extFromUrl('not a url'), '.mp4');
});

test('image names keep their real extension; video names keep .mp4', () => {
    assert.equal(safeName('sunset', `${TOS}/images/job-1-0.png`, 'asset-1'), 'sunset.png');
    assert.equal(safeName('clip', `${TOS}/videos/t.mp4`, 'asset-1'), 'clip.mp4');
    // Already-suffixed names aren't double-suffixed, case-insensitively.
    assert.equal(safeName('shot.PNG', `${TOS}/images/a.png`, 'asset-1'), 'shot.PNG');
});

test('names are sanitized for the filesystem and the Content-Disposition header', () => {
    assert.equal(safeName('../../etc/passwd', `${TOS}/images/a.png`, 'asset-1'), '.._.._etc_passwd.png');
    assert.equal(safeName('say "hi"\n', `${TOS}/images/a.png`, 'asset-1'), 'say hi.png');
    assert.equal(safeName('   ', `${TOS}/images/a.png`, 'asset-7'), 'asset-7.png');
    assert.equal(safeName(null, `${TOS}/videos/a.mp4`, 'asset-2'), 'asset-2.mp4');
    assert.ok(safeName('x'.repeat(400), `${TOS}/videos/a.mp4`, 'asset-1').length <= 124);
});
