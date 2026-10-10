import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Test-only DOM runtime, no browser or app dependency. For a temporary install:
// npm install --prefix /tmp/download-lifecycle-dom --no-save --ignore-scripts jsdom
// JSDOM_MODULE=/tmp/download-lifecycle-dom/node_modules/jsdom/lib/api.js node tests/dom/downloadPreviewLifecycle.mjs
// Set DOWNLOAD_PROGRESS_BASELINE_REV=63c360d to demonstrate the pre-fix failure.
const { JSDOM, VirtualConsole } = await import(process.env.JSDOM_MODULE || 'jsdom');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(repo + '/package.json');
const { build } = require('esbuild');
const out = await fs.mkdtemp(join(tmpdir(), 'download-preview-dom-'));
const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{AssetViewer}from'${repo}/app/seedance/SeedanceStudio.jsx';import{Lightbox}from'${repo}/app/gallery/shared.jsx';
const sample={status:'done',videoUrl:'/clip.mp4',archiveUrl:'/clip.mp4',prompt:'Download lifecycle preview',createdAt:Date.now(),duration:5,resolution:'1080p',modelName:'Seedance 2.0',mediaType:'video',options:{resolution:'1080p',duration:5}};
function App(){const[index,setIndex]=useState(0);const[open,setOpen]=useState(true);const[version,setVersion]=useState(0);window.reopen=()=>{setIndex(0);setOpen(true)};window.refresh=()=>setVersion(v=>v+1);const item={...sample,id:'sample'+index,taskId:'sample'+index,videoUrl:'/clip.mp4?v='+version,archiveUrl:'/clip.mp4?v='+version};const props={onClose:()=>setOpen(false),onPrev:index>0?()=>setIndex(index-1):null,onNext:index<1?()=>setIndex(index+1):null,onReuse:()=>{},onGenerateExr:()=>{},onToggleLike:()=>{},onRefresh:()=>{}};return open?(location.search.includes('gallery')?<Lightbox key={item.taskId} item={item} {...props}/>:<AssetViewer key={item.id} job={item} {...props}/>):<p>Preview closed</p>};createRoot(document.getElementById('root')).render(<App/>);`;
await build({
    stdin: { contents: entry, loader: 'jsx', resolveDir: repo }, bundle: true,
    outfile: out + '/app.js', jsx: 'automatic', platform: 'browser', alias: { '@': repo },
    define: { 'process.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'expose-preview', setup(b) {
        if (process.env.DOWNLOAD_PROGRESS_BASELINE_REV) b.onLoad({ filter: /\/app\/seedance\/DownloadProgress\.jsx$/ }, a => ({
            contents: execFileSync('git', ['show', `${process.env.DOWNLOAD_PROGRESS_BASELINE_REV}:app/seedance/DownloadProgress.jsx`], { cwd: repo, encoding: 'utf8' }),
            loader: 'jsx', resolveDir: repo + '/app/seedance',
        }));
        b.onResolve({ filter: /^@clerk\/nextjs$/ }, () => ({ path: 'clerk', namespace: 'test' }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const UserButton=()=>null;', loader: 'js' }));
        b.onLoad({ filter: /\/app\/seedance\/SeedanceStudio\.jsx$/ }, async a => ({
            contents: (await fs.readFile(a.path, 'utf8')) + '\nexport { AssetViewer };', loader: 'jsx', resolveDir: repo + '/app/seedance',
        }));
    } }],
});
const bundle = await fs.readFile(out + '/app.js', 'utf8');
const results = [];
async function until(predicate, label) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out: ' + label);
        await new Promise(resolve => setImmediate(resolve));
    }
}
try {
    for (const surface of ['studio', 'gallery']) {
        for (const scenario of ['refresh', 'navigation', 'close-reopen']) {
            const console = new VirtualConsole();
            const errors = [];
            console.on('jsdomError', error => errors.push(error.message));
            const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
                url: 'https://fixture.test/?' + surface, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
            });
            const { window } = dom;
            const requests = [], saves = [];
            window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
            window.HTMLElement.prototype.scrollIntoView = () => {};
            window.HTMLMediaElement.prototype.load = () => {};
            window.HTMLMediaElement.prototype.play = async () => {};
            window.HTMLMediaElement.prototype.pause = () => {};
            window.URL.createObjectURL = () => 'blob:fixture';
            window.URL.revokeObjectURL = () => {};
            window.HTMLAnchorElement.prototype.click = function () { saves.push(this.href); };
            window.fetch = async (url, options) => {
                assert.equal(url, '/api/seedance/download');
                return new Promise(resolve => requests.push({
                    body: JSON.parse(options.body), pending: true,
                    finish() { this.pending = false; resolve(new Response('complete fixture', { headers: { 'Content-Type': 'video/mp4' } })); },
                }));
            };
            const button = name => [...window.document.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') || element.textContent.trim()) === name);
            const processing = () => window.document.body.textContent.includes('Processing video…');
            window.eval(bundle);
            await until(() => button('Download') && !button('Download').disabled, 'initial download button');
            button('Download').click();
            await until(() => requests.length === 1 && processing(), 'active download');
            if (scenario === 'refresh') window.refresh();
            if (scenario === 'navigation') {
                button(surface === 'studio' ? 'Next' : 'Next generation').click();
                await until(() => button('Download'), 'other preview');
                assert.equal(button('Download').disabled, false, 'another asset remains available');
                button(surface === 'studio' ? 'Previous' : 'Previous generation').click();
            }
            if (scenario === 'close-reopen') {
                button('Close preview').click();
                await until(() => window.document.body.textContent.includes('Preview closed'), 'closed preview');
                window.reopen();
            }
            await until(() => button('Processing…') || button('Download'), 'returned preview');
            assert.equal(requests[0].pending, true);
            assert.equal(processing(), true, surface + ' ' + scenario + ': Processing disappeared during active request');
            assert.equal(button('Processing…').disabled, true);
            button('Processing…').click();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(requests.length, 1, 'reopened preview cannot duplicate the request');
            requests[0].finish();
            await until(() => button('Download'), 'completed request');
            assert.equal(processing(), false);
            assert.equal(saves.length, 1);
            assert.deepEqual(errors, []);
            results.push({ surface, scenario, pendingPreserved: true, duplicateBlocked: true });
            window.close();
        }
    }
    globalThis.console.log(JSON.stringify(results, null, 2));
} finally { await fs.rm(out, { recursive: true, force: true }); }
