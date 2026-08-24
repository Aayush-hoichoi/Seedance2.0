import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

import { TOS_ENDPOINT } from '../byteplus/tosSign.js';
import { MEDIA_APP_RESOURCE_URI } from './mediaAppConfig.mjs';
import { mediaAppHtml } from './ui/mediaAppHtml.mjs';

const bucket = process.env.TOS_BUCKET?.trim() || 'seedance-studio-assets';
const mediaOrigin = `https://${bucket}.${TOS_ENDPOINT}`;
const uiMeta = {
    prefersBorder: true,
    csp: { resourceDomains: [mediaOrigin] },
};

export function registerMediaAppResource(server) {
    registerAppResource(server, 'Logline AI generation media', MEDIA_APP_RESOURCE_URI, {
        description: 'Interactive image and video generation viewer.',
        _meta: { ui: uiMeta },
    }, async () => ({
        contents: [{
            uri: MEDIA_APP_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: mediaAppHtml(),
            _meta: { ui: uiMeta },
        }],
    }));
}
