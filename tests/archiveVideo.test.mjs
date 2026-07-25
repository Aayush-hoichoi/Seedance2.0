import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveVideo } from '../lib/seedance/archiveVideo.mjs';

// These exercise the validation guards only — they all reject BEFORE any fetch,
// so no network and no real TOS creds are needed.

test('archiveVideo: missing creds → 500 (checked before anything else)', async () => {
    const { ARK_AK, ARK_SK } = process.env;
    delete process.env.ARK_AK;
    delete process.env.ARK_SK;
    try {
        await assert.rejects(
            () => archiveVideo({ url: 'https://x.bytepluses.com/v.mp4', taskId: 't1' }),
            (err) => err.httpStatus === 500 && /ARK_AK/.test(err.message),
        );
    } finally {
        if (ARK_AK !== undefined) process.env.ARK_AK = ARK_AK;
        if (ARK_SK !== undefined) process.env.ARK_SK = ARK_SK;
    }
});

test('archiveVideo: rejects a non-BytePlus host (SSRF guard), no network', async () => {
    process.env.ARK_AK = 'test-ak';
    process.env.ARK_SK = 'test-sk';
    await assert.rejects(
        () => archiveVideo({ url: 'https://evil.example.com/v.mp4', taskId: 't1' }),
        (err) => err.httpStatus === 400 && /BytePlus media URL/.test(err.message),
    );
});

test('archiveVideo: requires url and taskId', async () => {
    process.env.ARK_AK = 'test-ak';
    process.env.ARK_SK = 'test-sk';
    await assert.rejects(
        () => archiveVideo({ url: '', taskId: '' }),
        (err) => err.httpStatus === 400 && /required/.test(err.message),
    );
});
