import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl } from '../lib/mcp/urlGuard.mjs';

function rejects(rawUrl) {
    assert.throws(() => assertPublicHttpUrl(rawUrl), (err) => err.code === 'BAD_REF_URL', rawUrl);
}

test('accepts public http(s) URLs', () => {
    assert.equal(assertPublicHttpUrl('https://example.com/a.png').href, 'https://example.com/a.png');
    assert.equal(assertPublicHttpUrl('http://cdn.foo.com/x').href, 'http://cdn.foo.com/x');
});

test('rejects non-http(s) protocols, localhost, private/reserved IPv4, IPv6 literals, and .internal names', () => {
    rejects('file:///etc/passwd');
    rejects('http://localhost/x');
    rejects('http://127.0.0.1/x');
    rejects('http://10.0.0.5/x');
    rejects('http://172.16.1.1/x');
    rejects('http://192.168.1.1/x');
    rejects('http://169.254.169.254/latest');
    rejects('http://[::1]/x');
    rejects('http://foo.internal/x');
});
