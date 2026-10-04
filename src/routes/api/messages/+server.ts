import { json } from '@sveltejs/kit';
import { listMessages } from '#lib/server/mail/messages.js';
import { parseFilter, scopeAccounts } from '#lib/server/mail/scope.js';
import type { RequestHandler } from './$types';

/** Further pages of a message list ("Load more"). */
export const GET: RequestHandler = async ({ url, locals }) => {
	const scope = url.searchParams.get('scope') ?? 'all';
	const folder = url.searchParams.get('folder') ?? 'inbox';
	const accounts = await scopeAccounts(locals.user.id, scope, folder);
	const query = url.searchParams.get('q')?.trim() || undefined;
	const filter = parseFilter(url.searchParams.get('filter'));
	return json(
		await listMessages(accounts, folder, { filter, query }, url.searchParams.get('cursor'))
	);
};
