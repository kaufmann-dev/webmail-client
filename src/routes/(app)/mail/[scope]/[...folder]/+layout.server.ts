import { listMessages } from '#lib/server/mail/messages.js';
import { parseFilter, scopeAccounts } from '#lib/server/mail/scope.js';
import type { LayoutServerLoad } from './$types';

/** The message list. Kept apart from the page load so opening a message does not re-list. */
export const load: LayoutServerLoad = async ({ params, url, locals, depends }) => {
	depends('mail:list');
	const folder = params.folder || 'inbox';
	const accounts = await scopeAccounts(locals.user.id, params.scope, folder);
	const filter = parseFilter(url.searchParams.get('filter'));
	const query = url.searchParams.get('q')?.trim() ?? '';
	const list = await listMessages(accounts, folder, { filter, query: query || undefined }, null);
	return { scope: params.scope, folder, filter, query, list };
};
