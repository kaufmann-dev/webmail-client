import { redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { building } from '$app/env';
import { auth, initAuth } from '#lib/server/auth.js';
import { isForbiddenCrossSiteForm } from '#lib/server/csrf.js';
import { db } from '#lib/server/db/index.js';
import { assertEnv } from '#lib/server/env.js';
import { startImapReaper } from '#lib/server/mail/imap.js';

export const init: ServerInit = async () => {
	assertEnv();
	await migrate(db, { migrationsFolder: 'drizzle' });
	await initAuth();
	startImapReaper();
};

/** Routes reachable without a browser session. The MCP endpoint verifies OAuth access tokens. */
function isPublic(pathname: string): boolean {
	return (
		pathname === '/login' ||
		pathname === '/mcp' ||
		pathname.startsWith('/api/auth/') ||
		pathname.startsWith('/.well-known/')
	);
}

export const handle: Handle = async ({ event, resolve }) => {
	if (isForbiddenCrossSiteForm(event.request, event.url)) {
		return new Response('Cross-site POST form submissions are forbidden', { status: 403 });
	}
	// OAuth discovery (RFC 8414, RFC 9728, OpenID) lives at the origin root, outside /api/auth.
	if (event.url.pathname.startsWith('/.well-known/') && !building) {
		return auth.handler(event.request);
	}
	if (!isPublic(event.url.pathname)) {
		const session = await auth.api.getSession({ headers: event.request.headers });
		if (!session) {
			const returnTo = event.url.pathname + event.url.search;
			redirect(303, `/login?returnTo=${encodeURIComponent(returnTo)}`);
		}
		event.locals.user = session.user;
	}
	return svelteKitHandler({ event, resolve, auth, building });
};
