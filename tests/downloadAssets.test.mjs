import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const stateKey = '__downloadAssetsTest';
const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../lib/seedance/downloadAssets.js', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    plugins: [{
        name: 'download-toast',
        setup(builder) {
            builder.onResolve({ filter: /^react-hot-toast$/ }, () => ({ path: 'toast', namespace: 'download-test' }));
            builder.onLoad({ filter: /.*/, namespace: 'download-test' }, () => ({
                contents: `export default { error(message) { globalThis.${stateKey}.showError(message); } };`,
                loader: 'js',
            }));
        },
    }],
});
const { downloadAsset } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const sourceUrl = 'https://seedance-studio-assets.tos-ap-southeast-1.bytepluses.com/videos/task-123.mp4';

function setup(t, response) {
    const state = { requests: [], opened: [], errors: [] };
    state.errorShown = new Promise((resolve) => {
        state.showError = (message) => { state.errors.push(message); resolve(); };
    });
    globalThis[stateKey] = state;
    const previousWindow = globalThis.window;
    globalThis.window = { open: (...args) => state.opened.push(args) };
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        state.requests.push(JSON.parse(init.body));
        return response;
    });
    t.after(() => {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        delete globalThis[stateKey];
    });
    return state;
}

test('failed ProRes conversion shows its error without opening the source MP4', { timeout: 3000 }, async (t) => {
    const state = setup(t, Response.json({ error: 'ProRes conversion failed.' }, { status: 500 }));

    downloadAsset(sourceUrl, 'shot', 'task-123', { format: 'prores' });
    await state.errorShown;

    assert.equal(state.requests[0].format, 'prores');
    assert.deepEqual(state.errors, ['ProRes conversion failed.']);
    assert.deepEqual(state.opened, [], 'a requested conversion must never fall back to the source MP4');
});

test('a broken ProRes response stream does not open the source MP4', { timeout: 3000 }, async (t) => {
    const state = setup(t, {
        ok: true,
        async blob() { throw new Error('The conversion stream was interrupted.'); },
    });

    downloadAsset(sourceUrl, 'shot', 'task-123', { format: 'prores' });
    await state.errorShown;

    assert.deepEqual(state.errors, ['The conversion stream was interrupted.']);
    assert.deepEqual(state.opened, []);
});

test('ordinary MOV downloads retain the existing original-file fallback', { timeout: 3000 }, async (t) => {
    const state = setup(t, Response.json({ error: 'The media proxy is unavailable.' }, { status: 502 }));

    downloadAsset(sourceUrl, 'shot', 'task-123', { format: 'mov' });
    await state.errorShown;

    assert.deepEqual(state.errors, ['The media proxy is unavailable.']);
    assert.deepEqual(state.opened, [[sourceUrl, '_blank', 'noopener']]);
});

test('a busy conversion shows the retry message without substituting the original codec', async (t) => {
    const state = setup(t, Response.json({ error: 'Another video is being converted. Please retry shortly.' }, { status: 429 }));
    await downloadAsset(sourceUrl, 'shot', 'task-123', { format: 'mov' });
    assert.deepEqual(state.errors, ['Another video is being converted. Please retry shortly.']);
    assert.deepEqual(state.opened, [], 'a busy encoder must not substitute an unconverted original');
});

test('an explicit Original download can still open the original URL after a proxy failure', { timeout: 3000 }, async (t) => {
    const state = setup(t, Response.json({ error: 'The media proxy is unavailable.' }, { status: 502 }));

    downloadAsset(sourceUrl, 'shot', 'task-123', { format: 'prores', raw: true });
    await state.errorShown;

    assert.equal(state.requests[0].raw, true);
    assert.deepEqual(state.errors, ['The media proxy is unavailable.']);
    assert.deepEqual(state.opened, [[sourceUrl, '_blank', 'noopener']]);
});
