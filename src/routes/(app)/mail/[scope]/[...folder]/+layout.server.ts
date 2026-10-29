import { listMessagesInStages } from '#lib/server/mail/messages.js';
import { parseFilter, scopeAccounts } from '#lib/server/mail/scope.js';
import type { LayoutServerLoad } from './$types';

/**
 * The message list. Kept apart from the page load so opening a message does not re-list. The
 * first page streams the accounts that answered in time; navigations and refreshes wait for them,
 * keeping the current list until then. Slower accounts follow in `lateList`. `listedAt` is the
 * server time listing began: actions that finished before it are in the list.
 */
export const load: LayoutServerLoad = async ({ params, url, locals, depends, isDataRequest }) => {
	depends('mail:list');
	const listedAt = Date.now();
	const folder = params.folder || 'inbox';
	const accounts = await scopeAccounts(locals.user.id, params.scope, folder);
	const filter = parseFilter(url.searchParams.get('filter'));
	const query = url.searchParams.get('q')?.trim() ?? '';
	const { early, late } = listMessagesInStages(accounts, folder, {
		filter,
		query: query || undefined
	});
	// The client sees a rejection; this only keeps it from going unhandled before Kit streams it.
	early.catch(() => {});
	late.catch(() => {});
	return {
		scope: params.scope,
		folder,
		filter,
		query,
		listedAt,
		list: isDataRequest ? await early : early,
		lateList: late
	};
};
