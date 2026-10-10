import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcileVideoTask } from '../lib/seedance/videoTaskState.mjs';

const taskId = 'cgt-current';
const running = {
    id: 'local-job', taskId, status: 'running', mediaType: 'video',
    createdAt: Date.now(), projectId: 3, liked: true, prompt: 'My video',
};
const success = { status: 'done', videoUrl: 'https://media.example/output.mp4', error: null, expired: false };

test('list completion followed by an older queued/running/error poll never hides the completed video', () => {
    const completed = reconcileVideoTask(running, taskId, success);
    for (const status of ['queued', 'running', 'error']) {
        assert.equal(reconcileVideoTask(completed, taskId, { status, error: 'Older poll failed' }), completed);
    }
    assert.equal(completed.id, running.id);
    assert.equal(completed.projectId, running.projectId);
    assert.equal(completed.liked, true);
    assert.equal(completed.prompt, running.prompt);
});

test('late updates from a different task cannot alter a reused local job', () => {
    for (const patch of [{ status: 'running' }, { status: 'error' }, success]) {
        assert.equal(reconcileVideoTask(running, 'cgt-previous', patch), running);
    }
});

test('real processing and failures still update a task that has not completed', () => {
    const queued = reconcileVideoTask(running, taskId, { status: 'queued' });
    assert.equal(queued.status, 'queued');
    const failed = reconcileVideoTask(queued, taskId, { status: 'error', error: 'Provider rejected input' });
    assert.equal(failed.status, 'error');
    assert.equal(failed.error, 'Provider rejected input');
    assert.equal(reconcileVideoTask(failed, taskId, success).status, 'done');
});

test('repeated completion preserves a valid decoded URL and repairs an expired one', () => {
    const completed = reconcileVideoTask(running, taskId, success);
    assert.equal(reconcileVideoTask(completed, taskId, { ...success, videoUrl: 'https://media.example/new-signature.mp4' }), completed);
    const expired = { ...completed, expired: true };
    const repaired = reconcileVideoTask(expired, taskId, { ...success, videoUrl: 'https://media.example/repaired.mp4' });
    assert.equal(repaired.videoUrl, 'https://media.example/repaired.mp4');
    assert.equal(repaired.expired, false);
});

test('a completed task awaiting URL renewal stays completed after an older failed poll', () => {
    const renewing = { ...running, status: 'done', videoUrl: null };
    assert.equal(reconcileVideoTask(renewing, taskId, { status: 'error', error: 'Network failed' }), renewing);
});

// Replay the actual Studio watcher with deferred provider responses. This
// covers its controller ownership and callback wiring, beyond the pure merge.
function studioWatcher(initial = running) {
    const source = readFileSync(new URL('../app/seedance/SeedanceStudio.jsx', import.meta.url), 'utf8');
    const start = source.indexOf('    const watchJob = (jobId, taskId) => {');
    const end = source.indexOf('\n    // On reload, restore history', start);
    assert.ok(start >= 0 && end > start, 'Studio watcher seam is present');
    let jobs = [initial];
    const calls = [], archives = [], finalizations = [];
    const controllersRef = { current: {} };
    const updateJobs = (fn) => { jobs = fn(jobs); };
    const patchJob = (id, patch) => updateJobs((prev) => prev.map((job) => job.id === id ? { ...job, ...patch } : job));
    const pollTask = (id, options) => new Promise((resolve, reject) => calls.push({ id, ...options, resolve, reject }));
    const createWatcher = new Function('pollTask', 'controllersRef', 'updateJobs', 'patchJob', 'reconcileVideoTask', 'archiveJob', 'fetch',
        `${source.slice(start, end)}; return watchJob;`);
    const watch = createWatcher(pollTask, controllersRef, updateJobs, patchJob, reconcileVideoTask,
        (...args) => archives.push(args), async (...args) => { finalizations.push(args); });
    return { watch, calls, archives, finalizations, controllersRef, jobs: () => jobs,
        completeFromList: () => updateJobs((prev) => prev.map((job) => reconcileVideoTask(job, taskId, success))) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('actual Studio watcher cannot undo list completion with late status or failure callbacks', async () => {
    const replay = studioWatcher();
    replay.watch(running.id, taskId);
    replay.completeFromList();
    replay.calls[0].onStatus('running');
    replay.calls[0].reject(new Error('An older request failed'));
    await settle();
    assert.equal(replay.jobs()[0].status, 'done');
    assert.equal(replay.jobs()[0].videoUrl, success.videoUrl);
    assert.equal(replay.jobs()[0].error, null);
    assert.equal(replay.finalizations.length, 1);
});

test('superseded Studio watcher is aborted and cannot change state, archive, or clear its replacement', async () => {
    const replay = studioWatcher();
    replay.watch(running.id, taskId);
    const old = replay.calls[0];
    replay.watch(running.id, taskId);
    const current = replay.calls[1];
    assert.equal(old.signal.aborted, true);
    old.onStatus('queued');
    old.resolve({ url: 'https://media.example/older.mp4' });
    await settle();
    assert.equal(replay.jobs()[0].status, 'running');
    assert.equal(replay.archives.length, 0);
    assert.equal(replay.finalizations.length, 1);
    assert.equal(replay.controllersRef.current[running.id].signal, current.signal);
    current.resolve({ url: success.videoUrl });
    await settle();
    assert.equal(replay.jobs()[0].status, 'done');
    assert.equal(replay.archives.length, 1);
    assert.equal(replay.finalizations.length, 2);
    assert.equal(replay.controllersRef.current[running.id], undefined);
});

test('unmount cancellation does not mark a still-running Studio task as failed', async () => {
    const replay = studioWatcher();
    replay.watch(running.id, taskId);
    replay.controllersRef.current[running.id].abort();
    replay.calls[0].reject(new Error('Cancelled.'));
    await settle();
    assert.equal(replay.jobs()[0].status, 'running');
    assert.equal(replay.finalizations.length, 1);
});
