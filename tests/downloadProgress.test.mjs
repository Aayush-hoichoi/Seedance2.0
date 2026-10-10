import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadKeyForAsset, getDownloadProgress, runTrackedDownload, subscribeToDownload } from '../lib/seedance/downloadProgress.mjs';

test('Studio and Gallery use the same stable download identity', () => {
    assert.equal(downloadKeyForAsset({ taskId: 'cgt-video', genId: 12 }), downloadKeyForAsset({ taskId: 'cgt-video' }));
    assert.equal(downloadKeyForAsset({ genId: 12 }), downloadKeyForAsset({ taskId: 'job:12' }));
    assert.equal(downloadKeyForAsset({ gatewayId: 12 }), 'job:12');
    assert.equal(downloadKeyForAsset({ id: 'local' }), 'local:local');
    assert.equal(downloadKeyForAsset({}), null);
});

test('a remounted subscriber recovers the active download and cannot start a duplicate', async () => {
    const key = Symbol('asset');
    const updates = [];
    let complete;
    let calls = 0;
    const firstUnmount = subscribeToDownload(key, () => updates.push(getDownloadProgress(key)));
    const first = runTrackedDownload(key, () => { calls++; return new Promise(resolve => { complete = resolve; }); });
    await Promise.resolve();
    firstUnmount();
    assert.equal(getDownloadProgress(key), 'video');
    const reopenedUpdates = [];
    const secondUnmount = subscribeToDownload(key, () => reopenedUpdates.push(getDownloadProgress(key)));
    const duplicate = runTrackedDownload(key, () => { calls++; });
    assert.equal(duplicate, first);
    assert.equal(calls, 1);
    assert.equal(getDownloadProgress(Symbol('different asset')), null);
    complete();
    await first;
    assert.equal(getDownloadProgress(key), null);
    assert.deepEqual(updates, ['video'], 'unmounted subscriber must stop receiving updates');
    assert.deepEqual(reopenedUpdates, [null]);
    secondUnmount();
});

test('a failed download clears its entry and a retry runs independently', async () => {
    const key = Symbol('failed asset');
    await assert.rejects(runTrackedDownload(key, () => { throw new Error('Fixture failure'); }), /Fixture failure/);
    assert.equal(getDownloadProgress(key), null);
    let completed = false;
    await runTrackedDownload(key, () => { completed = true; }, 'file');
    assert.equal(completed, true);
    assert.equal(getDownloadProgress(key), null);
});
