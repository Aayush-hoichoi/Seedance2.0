import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { auth } from '@clerk/nextjs/server';
import { verifyClerkToken } from '@clerk/mcp-tools/next';
import { registerCatalogTools } from '../../../../lib/mcp/tools/catalog.js';
import { registerProjectTools } from '../../../../lib/mcp/tools/projects.js';
import { registerHistoryTools } from '../../../../lib/mcp/tools/history.js';
import { registerAssetTools } from '../../../../lib/mcp/tools/assets.js';
import { registerGenerateTools } from '../../../../lib/mcp/tools/generate.js';

export const runtime = 'nodejs';
export const maxDuration = 300; // register_asset polls; video status may sweep

const handler = createMcpHandler(
    (server) => {
        server.tool('ping', 'Connectivity check — returns pong and your user id.', {}, async (_args, extra) => ({
            content: [{ type: 'text', text: JSON.stringify({ pong: true, userId: extra?.authInfo?.extra?.userId ?? null }) }],
        }));
        registerCatalogTools(server);
        registerProjectTools(server);
        registerHistoryTools(server);
        registerAssetTools(server);
        registerGenerateTools(server);
    },
    {},
    { basePath: '/api/mcp' }, // endpoint: /api/mcp/mcp (streamable HTTP)
);

const verify = async (_req, token) => {
    const clerkAuth = await auth({ acceptsToken: 'oauth_token' });
    return verifyClerkToken(clerkAuth, token);
};

const authHandler = withMcpAuth(handler, verify, {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp',
});

export { authHandler as GET, authHandler as POST };
