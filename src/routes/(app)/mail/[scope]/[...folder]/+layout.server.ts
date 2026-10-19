import { listMessages } from '#lib/server/mail/messages.js';
import { parseFilter, scopeAccounts } from '#lib/server/mail/scope.js';
import type { LayoutServerLoad } from './$types';

/**
 * The message list. Kept apart from the page load so opening a message does not re-list. The
 * first page streams it; navigations and refreshes wait for it, keeping the current list until then.
 */
export const load: LayoutServerLoad = async ({ params, url, locals, depends, isDataRequest }) => {
	depends('mail:list');
	const folder = params.folder || 'inbox';
	const accounts = await scopeAccounts(locals.user.id, params.scope, folder);
	const filter = parseFilter(url.searchParams.get('filter'));
	const query = url.searchParams.get('q')?.trim() ?? '';
	const list = listMessages(accounts, folder, { filter, query: query || undefined }, null);
	// The client sees a rejection; this only keeps it from going unhandled before Kit streams it.
	list.catch(() => {});
	return {
		scope: params.scope,
		folder,
		filter,
		query,
		list: isDataRequest ? await list : list
	};
};
