import { listAccounts, toSummary } from '#lib/server/mail/accounts.js';
import { getFolders, inboxUnreadCounts } from '#lib/server/mail/folders.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	depends('mail:counts');
	const accounts = await listAccounts(locals.user.id);
	const [unread, folders] = await Promise.all([
		inboxUnreadCounts(accounts),
		Promise.all(accounts.map((account) => getFolders(account).catch(() => [])))
	]);
	return {
		user: { name: locals.user.name, email: locals.user.email },
		accounts: accounts.map(toSummary),
		unread,
		folders: Object.fromEntries(accounts.map((account, i) => [account.id, folders[i]]))
	};
};
