import { error, fail } from '@sveltejs/kit';
import { auth } from '#lib/server/auth.js';
import { listAccounts, toSummary } from '#lib/server/mail/accounts.js';
import {
	getClientAccess,
	grantsFromForm,
	setClientAccess
} from '#lib/server/mcp/connected-apps.js';
import type { Actions, PageServerLoad } from './$types';

async function loadClient(url: URL, headers: Headers) {
	const clientId = url.searchParams.get('client_id');
	if (!clientId || !url.searchParams.has('sig'))
		error(400, 'This authorization request is incomplete or has expired.');
	const client = await auth.api
		.getOAuthClientPublic({ query: { client_id: clientId }, headers })
		.catch(() => null);
	if (!client) error(400, 'Unknown application.');
	return { clientId, client };
}

export const load: PageServerLoad = async ({ url, request, locals }) => {
	const { clientId, client } = await loadClient(url, request.headers);
	const redirectHosts = [
		...new Set(
			(client.redirect_uris ?? []).flatMap((uri: string) => {
				try {
					return [new URL(uri).host];
				} catch {
					return [];
				}
			})
		)
	];
	const [accounts, access] = await Promise.all([
		listAccounts(locals.user.id),
		getClientAccess(locals.user.id, clientId)
	]);
	return {
		client: { name: client.client_name ?? clientId, uri: client.client_uri ?? null, redirectHosts },
		accounts: accounts.map(toSummary),
		access
	};
};

export const actions: Actions = {
	/** Stores the chosen accounts before the client finishes consent with Better Auth. */
	grant: async ({ url, request, locals }) => {
		const { clientId } = await loadClient(url, request.headers);
		const grants = grantsFromForm(await request.formData());
		if (!grants.length) return fail(400, { error: 'Choose at least one mail account.' });
		await setClientAccess(locals.user.id, clientId, grants);
		return { granted: grants.length };
	}
};
