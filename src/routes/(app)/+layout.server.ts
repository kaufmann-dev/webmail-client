import { listAccounts, toSummary } from '#lib/server/mail/accounts.js';
import { getFolders, inboxUnreadCounts } from '#lib/server/mail/folders.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, depends, isDataRequest }) => {
	depends('mail:counts');
	const accounts = await listAccounts(locals.user.id);
	const unread = inboxUnreadCounts(accounts);
	const folders = Promise.all(accounts.map((account) => getFolders(account).catch(() => []))).then(
		(lists) => Object.fromEntries(accounts.map((account, i) => [account.id, lists[i]]))
	);
	const user = { name: locals.user.name, email: locals.user.email };
	// The first page streams these so the shell shows at once; navigations and refreshes wait for
	// them, keeping the current view until they are ready.
	if (isDataRequest) {
		const [counts, lists] = await Promise.all([unread, folders]);
		return { user, accounts: accounts.map(toSummary), unread: counts, folders: lists };
	}
	return { user, accounts: accounts.map(toSummary), unread, folders };
};
