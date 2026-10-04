import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { getRequestEvent } from '$app/server';

import {
	ORIGIN,
	BETTER_AUTH_SECRET,
	POCKET_ID_CLIENT_ID,
	POCKET_ID_CLIENT_SECRET,
	POCKET_ID_ISSUER
} from '$app/env/private';

import { db } from './db';
import * as schema from './db/schema';
import { withInferredApplicationType } from './oauth-registration';

export const POCKET_ID_PROVIDER = 'pocket-id';

const origin = (ORIGIN ?? '').replace(/\/$/, '');

/** The MCP endpoint's protected resource identifier (RFC 8707 / RFC 9728); tokens carry it as `aud`. */
export const MCP_RESOURCE = `${origin}/mcp`;

/**
 * The single tool scope. Which mail accounts a client may use, and how, is chosen per client on the
 * consent screen and stored in `mcp_account_access`, because accounts are not static OAuth scopes.
 */
export const MCP_SCOPE = 'mail';

/** Scopes MCP clients may request: identity, refresh tokens (`offline_access`), and mail access. */
export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access', MCP_SCOPE];

function createAuth() {
	return betterAuth({
		baseURL: origin,
		secret: BETTER_AUTH_SECRET,
		database: drizzleAdapter(db, { provider: 'pg', schema }),
		emailAndPassword: { enabled: false },
		// Browser sessions end seven days after sign-in and are never extended.
		session: { expiresIn: 60 * 60 * 24 * 7, disableSessionRefresh: true },
		// Coolify's proxy forwards the client address; rate limiting keys on it.
		advanced: { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
		// The OAuth provider issues tokens at /oauth2/token; the JWT plugin's session-token route is unused.
		disabledPaths: ['/token'],
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== '/oauth2/register' || !ctx.body) return;
				return { context: { body: withInferredApplicationType(ctx.body) } };
			})
		},
		plugins: [
			genericOAuth({
				config: [
					{
						providerId: POCKET_ID_PROVIDER,
						clientId: POCKET_ID_CLIENT_ID ?? '',
						clientSecret: POCKET_ID_CLIENT_SECRET,
						discoveryUrl: `${(POCKET_ID_ISSUER ?? '').replace(/\/$/, '')}/.well-known/openid-configuration`,
						scopes: ['openid', 'email', 'profile']
					}
				]
			}),
			jwt(),
			// OAuth 2.1 authorization server for MCP clients: authorization code with PKCE, rotating
			// refresh tokens, audience-bound JWT access tokens, and RFC 8414 / RFC 9728 discovery.
			mcp({
				loginPage: '/login',
				consentPage: '/consent',
				resource: MCP_RESOURCE,
				scopes: OAUTH_SCOPES,
				clientRegistrationDefaultScopes: OAUTH_SCOPES,
				// Access tokens are stateless JWTs; a short lifetime bounds access after a revoke.
				accessTokenExpiresIn: 15 * 60,
				// Dynamic Client Registration for clients that predate Client ID Metadata Documents.
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true
			}),
			cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
			sveltekitCookies(getRequestEvent)
		]
	});
}

type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth initializes eagerly (provider discovery, OAuth resource seeding in the database), so
 * it is created by `initAuth` from the server `init` hook, after migrations have run, never at
 * import time (which also happens during `vite build`, without runtime configuration).
 */
export let auth: Auth;

export async function initAuth(): Promise<void> {
	auth = createAuth();
	// Pocket ID's discovery document is read once. Refuse to start rather than serve a login that
	// can never work, so the platform restarts the app until Pocket ID is reachable.
	const context = await auth.$context;
	if (!context.socialProviders.some((p) => p.id === POCKET_ID_PROVIDER)) {
		throw new Error('Pocket ID discovery failed; check POCKET_ID_ISSUER and that Pocket ID is up.');
	}
}
