import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the actual resource descriptor and response; replace only the SDK
// registration boundary and the large self-contained HTML payload.
const stateKey = '__mcpMediaCdnTest';
const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../lib/mcp/mediaAppResource.mjs', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
        name: 'mcp-resource-boundaries',
        setup(builder) {
            builder.onResolve({ filter: /^@modelcontextprotocol\/ext-apps\/server$/ }, () => ({ path: 'sdk', namespace: 'mcp-test' }));
            builder.onResolve({ filter: /\/mediaAppHtml\.mjs$/ }, () => ({ path: 'html', namespace: 'mcp-test' }));
            builder.onLoad({ filter: /.*/, namespace: 'mcp-test' }, ({ path }) => ({
                contents: path === 'sdk'
                    ? `export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'; export const registerAppResource = (...args) => { globalThis.${stateKey} = args; };`
                    : `export const mediaAppHtml = () => '<!doctype html><title>Media</title>';`,
                loader: 'js',
            }));
        },
    }],
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
let importId = 0;

for (const cdn of [undefined, 'video-cdn.example.com']) {
    test(`MCP media CSP ${cdn ? 'allows the configured CDN' : 'preserves TOS-only delivery without a CDN'}`, async (t) => {
        for (const [key, value] of Object.entries({ VIDEO_CDN_DOMAIN: cdn, TOS_BUCKET: 'test-video-bucket' })) {
            const previous = process.env[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
            t.after(() => {
                if (previous === undefined) delete process.env[key];
                else process.env[key] = previous;
            });
        }
        t.after(() => { delete globalThis[stateKey]; });
        const { registerMediaAppResource } = await import(`${moduleUrl}#${++importId}`);
        registerMediaAppResource({});
        const [, , uri, descriptor, readResource] = globalThis[stateKey];
        const expected = ['https://test-video-bucket.tos-ap-southeast-1.bytepluses.com'];
        if (cdn) expected.push(`https://${cdn}`);
        assert.deepEqual(descriptor._meta.ui.csp.resourceDomains, expected);
        const { contents } = await readResource();
        assert.equal(contents[0].uri, uri);
        assert.deepEqual(contents[0]._meta.ui.csp.resourceDomains, expected);
    });
}
