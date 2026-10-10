import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Actual React components in a test DOM, without a browser or app dependency.
// npm install --prefix /tmp/download-lifecycle-dom --no-save --ignore-scripts jsdom
// JSDOM_MODULE=/tmp/download-lifecycle-dom/node_modules/jsdom/lib/api.js node tests/dom/videoThumbnailLifecycle.mjs
const { JSDOM, VirtualConsole } = await import(process.env.JSDOM_MODULE || 'jsdom');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(repo + '/package.json');
const out = await fs.mkdtemp(join(tmpdir(), 'video-thumbnail-dom-'));
await require('esbuild').build({
    stdin: { contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import VideoThumbnail from'${repo}/app/seedance/VideoThumbnail.jsx';import{SmartVideo}from'${repo}/app/gallery/shared.jsx';function App(){const[items,setItems]=useState([{taskId:'first',archiveUrl:'/archive-a.mp4'}]);const[hover,setHover]=useState(false);const[tick,setTick]=useState(0);window.update=setItems;window.hover=setHover;window.refresh=()=>setTick(x=>x+1);return <div data-render={tick}>{items.map(item=><div key={item.taskId} data-task={item.taskId}>{location.search.includes('player')?<SmartVideo item={item} onUnavailable={()=>window.unavailable++}/>:<VideoThumbnail item={item} visible={true} hovered={hover} Player={SmartVideo}/>}</div>)}</div>}window.unavailable=0;createRoot(document.getElementById('root')).render(<App/>);`, loader: 'jsx', resolveDir: repo },
    bundle: true, outfile: out + '/app.js', jsx: 'automatic', platform: 'browser', alias: { '@': repo }, define: { 'process.env': '{}' }, logLevel: 'silent',
});
const bundle = await fs.readFile(out + '/app.js', 'utf8');
const results = [];
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate, label) {
    const deadline = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await settle(); }
}
function fixture(player = false) {
    const errors = [], requests = [], draws = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error.message));
    virtualConsole.on('error', (...args) => errors.push(args.map(String).join(' ')));
    const dom = new JSDOM('<div id="root"></div>', { url: 'https://fixture.test/' + (player ? '?player' : ''), runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
    const { window } = dom;
    window.HTMLMediaElement.prototype.load = function () {};
    window.HTMLMediaElement.prototype.pause = function () {};
    window.HTMLMediaElement.prototype.play = async function () {};
    window.HTMLCanvasElement.prototype.getContext = function () { return { drawImage: video => draws.push({ canvas: this, video }) }; };
    window.fetch = (url, options) => new Promise(resolve => requests.push({ url, signal: options.signal, finish: data => resolve({ ok: true, json: async () => data }) }));
    window.eval(bundle);
    return { dom, window, document: window.document, requests, errors, draws,
        video: (id = 'first') => window.document.querySelector(`[data-task="${id}"] video`),
        state: (id = 'first') => window.document.querySelector(`[data-task="${id}"] [data-preview-state]`)?.dataset.previewState,
        error(video) { video.dispatchEvent(new window.Event('error')); },
        frame(video) { for (const [key, value] of Object.entries({ readyState: 2, videoWidth: 640, videoHeight: 360, seeking: false })) Object.defineProperty(video, key, { configurable: true, value }); video.dispatchEvent(new window.Event('loadeddata')); },
    };
}
try {
    {
        const f = fixture(); try {
            await until(() => f.video(), 'initial preview');
            f.window.update([{ taskId: 'first', archiveUrl: '/archive-b.mp4' }]);
            await until(() => f.video()?.getAttribute('src') === '/archive-b.mp4', 'pending source renewal');
            f.frame(f.video()); await until(() => f.state() === 'ready', 'renewed frame');
            assert.equal(f.requests.length, 0);
            const canvas = f.document.querySelector('canvas'), count = f.draws.length;
            for (let i = 0; i < 30; i++) { f.window.refresh(); await settle(); }
            assert.ok(f.document.querySelector('canvas') === canvas);
            assert.equal(f.draws.length, count);
            assert.equal(f.state(), 'ready');
            results.push('pending source renewal and ready canvas retention');
        } finally { f.dom.window.close(); assert.deepEqual(f.errors, []); }
    }
    {
        const f = fixture(); try {
            await until(() => f.video(), 'initial preview'); f.error(f.video());
            await until(() => f.requests.length === 1, 'task fallback');
            f.window.update([{ taskId: 'first', archiveUrl: '/archive-b.mp4' }]);
            await until(() => f.video()?.getAttribute('src') === '/archive-b.mp4', 'new archive');
            assert.equal(f.requests[0].signal.aborted, true);
            f.requests[0].finish({ content: { video_url: '/obsolete-live.mp4' } }); await settle();
            assert.equal(f.video().getAttribute('src'), '/archive-b.mp4');
            f.frame(f.video()); await until(() => f.state() === 'ready', 'frame after cancelled lookup');
            results.push('late fallback cannot overwrite renewed archive');
        } finally { f.dom.window.close(); assert.deepEqual(f.errors, []); }
    }
    {
        const f = fixture(true); try {
            await until(() => f.video(), 'initial player');
            const video = f.video(); f.frame(video); video.currentTime = 7;
            f.window.update([{ taskId: 'first', archiveUrl: '/archive-b.mp4' }]); await settle();
            assert.ok(f.video() === video);
            assert.equal(video.getAttribute('src'), '/archive-a.mp4');
            assert.equal(video.currentTime, 7);
            f.error(video); await until(() => f.video()?.getAttribute('src') === '/archive-b.mp4', 'fresh source after working source fails');
            assert.equal(f.requests.length, 0);
            results.push('signature renewal preserves playback until a real source error');
        } finally { f.dom.window.close(); assert.deepEqual(f.errors, []); }
    }
    {
        const f = fixture(true); try {
            await until(() => f.video(), 'initial player'); f.error(f.video());
            await until(() => f.requests.length === 1, 'task fallback');
            f.requests[0].finish({ content: { video_url: '/live.mp4' } });
            await until(() => f.video()?.getAttribute('src') === '/live.mp4', 'live fallback');
            f.error(f.video()); await until(() => !f.video(), 'live fallback failure stops');
            assert.equal(Boolean(f.video()), false, 'failed live fallback must not retry the already-failed archive');
            assert.equal(f.window.unavailable, 1); assert.equal(f.requests.length, 1);
            results.push('failed live fallback stops after one archive and task attempt');
        } finally { f.dom.window.close(); assert.deepEqual(f.errors, []); }
    }
    {
        const f = fixture(); try {
            await until(() => f.video(), 'initial preview');
            f.window.update([{ taskId: 'first', archiveUrl: '/one.mp4' }, { taskId: 'second', archiveUrl: '/two.mp4' }, { taskId: 'third', archiveUrl: '/three.mp4' }]);
            await until(() => f.video('first') && f.video('second'), 'two decode slots');
            assert.equal(f.video('third'), null);
            f.error(f.video('first')); f.error(f.video('second'));
            await until(() => f.requests.length === 2, 'two task lookups');
            f.requests[0].finish({ status: 'running' }); f.requests[1].finish({ status: 'queued' });
            await until(() => f.state('first') === 'processing' && f.state('second') === 'processing' && f.video('third'), 'processing releases decode slots');
            assert.match(f.document.body.textContent, /Still rendering/); assert.match(f.document.body.textContent, /Queued/);
            f.frame(f.video('third')); await until(() => f.state('third') === 'ready', 'third card decoded');
            for (let i = 0; i < 10; i++) { f.window.refresh(); f.window.hover(i % 2 === 0); await settle(); }
            assert.equal(f.state('first'), 'processing'); assert.equal(f.requests.length, 2);
            f.window.hover(false); f.window.update([{ taskId: 'first', archiveUrl: '/completed.mp4', status: 'succeeded' }]);
            await until(() => f.video()?.getAttribute('src') === '/completed.mp4', 'processing receives completed source');
            f.frame(f.video()); await until(() => f.state() === 'ready', 'processing recovers');
            assert.deepEqual(f.errors, []);
            results.push('running and queued remain distinct from errors, release queue, and recover');
        } finally { f.dom.window.close(); assert.deepEqual(f.errors, []); }
    }
    console.log(JSON.stringify(results, null, 2));
} finally { await fs.rm(out, { recursive: true, force: true }); }
