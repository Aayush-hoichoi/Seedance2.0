import { protectedResourceHandlerClerk, metadataCorsOptionsRequestHandler } from '@clerk/mcp-tools/next';

// OAuth 2.0 Protected Resource Metadata (RFC 9728): tells MCP clients that
// Clerk is the authorization server for the /api/mcp/mcp resource.
const handler = protectedResourceHandlerClerk({ scopes_supported: ['email', 'profile'] });
const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
