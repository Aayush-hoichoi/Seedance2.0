import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { TOOL_PERMISSIONS, createVideoShape, refsShape } from '../lib/mcp/schemas.mjs';

test('every generation/asset tool requires generation.create; usage tools require usage.view', () => {
    for (const t of ['create_video', 'create_image', 'list_assets', 'register_asset', 'create_upload_url', 'delete_asset']) {
        assert.equal(TOOL_PERMISSIONS[t], 'generation.create', t);
    }
    assert.equal(TOOL_PERMISSIONS.get_usage, 'usage.view');
    assert.equal(TOOL_PERMISSIONS.resolve_access_request, 'model.grant');
    assert.equal(TOOL_PERMISSIONS.set_quota, 'quota.manage');
    assert.equal(TOOL_PERMISSIONS.view_audit, 'audit.view');
});

test('create_video shape validates refs and rejects junk', () => {
    const S = z.object(createVideoShape);
    const ok = S.safeParse({ model: 'seedance-2.0-mini', prompt: 'a cat', refs: [{ assetId: '123', role: 'first_frame' }] });
    assert.equal(ok.success, true);
    assert.equal(S.safeParse({ model: 'seedance-2.0-mini' }).success, false); // prompt required
    const badRole = z.object({ refs: z.array(z.object(refsShape)) }).safeParse({ refs: [{ url: 'https://x/y.png', role: 'banana' }] });
    assert.equal(badRole.success, false);
});
