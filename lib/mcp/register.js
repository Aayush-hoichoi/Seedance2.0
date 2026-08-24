// lib/mcp/register.js — every MCP tool goes through here: resolve the Clerk
// user from the OAuth token, validate, run, JSON-serialize, format errors.
import { getUserById } from '../auth/user.js';
import { gatewayContextFor } from '../gateway/authz.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';

export class ToolError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function textResult(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

// Tools normally return JSON (wrapped as one text block). rawContent() lets a
// tool return rich MCP content — e.g. inline image blocks that render
// directly in the chat — unchanged.
export function rawContent(blocks, { structuredContent, meta } = {}) {
    return {
        __mcpResult: {
            content: blocks,
            ...(structuredContent === undefined ? {} : { structuredContent }),
            ...(meta === undefined ? {} : { _meta: meta }),
        },
    };
}

function errorResult(code, message) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] };
}

export function registerTool(server, { name, title, description, schema = {}, annotations, meta, run }) {
    const handler = async (args, extra) => {
        const userId = extra?.authInfo?.extra?.userId ?? null;
        const user = await getUserById(userId);
        if (!user) return errorResult('UNAUTHORIZED', 'Could not resolve your account from the OAuth token.');
        try {
            const result = await run({ user, args: args ?? {} });
            if (result?.__mcpResult) return result.__mcpResult;
            return textResult(result);
        } catch (error) {
            if (error instanceof ToolError) return errorResult(error.code, error.message);
            console.error(`[mcp:${name}]`, error);
            return errorResult('TOOL_FAILED', 'The tool failed unexpectedly — try again or check the studio.');
        }
    };

    // registerTool is the current SDK API and, unlike the legacy positional
    // server.tool() overload, carries MCP Apps metadata and annotations.
    const config = {
        ...(title ? { title } : {}),
        description,
        inputSchema: schema,
        ...(annotations ? { annotations } : {}),
        ...(meta ? { _meta: meta } : {}),
    };
    if (meta?.ui?.resourceUri) registerAppTool(server, name, config, handler);
    else server.registerTool(name, config, handler);
}

// Gateway context for a tool call; throws a ToolError carrying the gateway's
// own code/message so denials read exactly like the studio's.
export async function toolGatewayCtx(user, { projectId = null, permission = null } = {}) {
    const auth = await gatewayContextFor(user, { projectId, permission });
    if (!auth.ok) {
        const body = await auth.response.json().catch(() => ({}));
        throw new ToolError(body.code ?? 'FORBIDDEN', body.message ?? body.error ?? 'Not allowed.');
    }
    return auth.ctx;
}
