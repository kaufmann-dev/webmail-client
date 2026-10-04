import { createMcpHandler } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import type { RequestHandler } from './$types';
import { auth, MCP_RESOURCE, MCP_SCOPE } from '#lib/server/auth.js';
import { McpAccess } from '#lib/server/mcp/access.js';
import { createMcpServer } from '#lib/server/mcp/tools.js';

/**
 * Serves the 2026-07-28 protocol and, statelessly, 2025-era clients. Each request builds a server
 * bound to the token's user and to the mail accounts the user granted this OAuth client.
 */
const mcpHandler = createMcpHandler(async ({ authInfo }) => {
	const userId = String(authInfo?.extra?.userId ?? '');
	const clientId = authInfo?.clientId ?? '';
	return createMcpServer(userId, await McpAccess.load(userId, clientId));
});

type AccessTokenClaims = Parameters<Parameters<typeof requireMcpAuth>[1]>[1];

function serve(request: Request, claims: AccessTokenClaims): Promise<Response> {
	const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
	const clientId = typeof claims.azp === 'string' ? claims.azp : String(claims.client_id ?? '');
	return mcpHandler.fetch(request, {
		authInfo: {
			token: request.headers.get('authorization')?.replace(/^\S+\s+/, '') ?? '',
			clientId,
			scopes,
			expiresAt: claims.exp,
			resource: new URL(MCP_RESOURCE),
			extra: { userId: claims.sub }
		}
	});
}

let guard: ((request: Request) => Promise<Response>) | undefined;

/**
 * Tokens are verified before any tool runs: missing or invalid tokens get a 401 pointing at the
 * protected resource metadata. Per-account permissions are checked inside each tool.
 */
export const POST: RequestHandler = ({ request }) => {
	// Created on first use: `auth` exists only after the server init hook has run.
	guard ??= requireMcpAuth(auth, serve, {
		resource: MCP_RESOURCE,
		requiredScopes: [MCP_SCOPE],
		challengeScopes: [MCP_SCOPE, 'offline_access']
	});
	return guard(request);
};

const methodNotAllowed: RequestHandler = () =>
	new Response(null, { status: 405, headers: { Allow: 'POST' } });
export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
