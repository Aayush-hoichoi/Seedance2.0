// E2E check of the direct-to-TOS upload flow, including the CORS preflight
// browsers send. Run: node scripts/test-upload-flow.mjs
import { readFileSync } from 'node:fs';
import { signTosRequest, presignPutUrl, presignGetUrl, encodePath, TOS_ENDPOINT } from '../lib/byteplus/tosSign.js';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ak = process.env.ARK_AK;
const sk = process.env.ARK_SK;
const BUCKET = process.env.TOS_BUCKET || 'seedance-studio-assets';
const host = `${BUCKET}.${TOS_ENDPOINT}`;
if (!ak || !sk) throw new Error('ARK_AK / ARK_SK missing');

async function tosFetch(method, path, { query = '', body, contentType } = {}) {
    const headers = signTosRequest({
        method, host, path, query, ak, sk,
        extraHeaders: contentType ? { 'content-type': contentType } : {},
    });
    return fetch(`https://${host}${path}${query ? `?${query}` : ''}`, { method, headers, body });
}

// 1. bucket
const mk = await tosFetch('PUT', '/');
console.log('1. ensure bucket:', mk.status, mk.ok || mk.status === 409 ? 'OK' : await mk.text());

// 2. CORS config
const corsBody = JSON.stringify({
    CORSRules: [{
        AllowedOrigins: ['*'],
        AllowedMethods: ['PUT', 'GET', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
    }],
});
const cors = await tosFetch('PUT', '/', { query: 'cors=', body: corsBody, contentType: 'application/json' });
console.log('2. put CORS:', cors.status, cors.ok ? 'OK' : await cors.text());

// 3. presigned PUT
const key = `uploads/test-${Date.now()}.txt`;
const path = `/${encodePath(key)}`;
const putUrl = presignPutUrl({ host, path, contentType: 'text/plain', ak, sk });

// 3a. browser-style preflight
const pre = await fetch(putUrl, {
    method: 'OPTIONS',
    headers: {
        Origin: 'https://seedance2-0-ruby.vercel.app',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
    },
});
console.log('3. preflight OPTIONS:', pre.status,
    'allow-origin =', pre.headers.get('access-control-allow-origin'),
    'allow-methods =', pre.headers.get('access-control-allow-methods'));

// 3b. actual PUT
const put = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello seedance',
});
console.log('4. presigned PUT:', put.status, put.ok ? 'OK' : await put.text());

// 4. presigned GET round-trip
const getUrl = presignGetUrl({ host, path, ak, sk });
const got = await fetch(getUrl);
const text = await got.text();
console.log('5. presigned GET:', got.status, text === 'hello seedance' ? 'round-trip OK' : `BAD: ${text.slice(0, 120)}`);
