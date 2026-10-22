import { listAccounts, toSummary } from '#lib/server/mail/accounts.js';
import { getFolders, inboxUnread, type Folder } from '#lib/server/mail/folders.js';
import { inStages } from '#lib/server/mail/stages.js';
import type { LayoutServerLoad } from './$types';

interface Mailbox {
	unread: number | null;
	folders: Folder[];
}

function mailboxes(results: Map<string, Mailbox>) {
	const entries = [...results];
	return {
		unread: Object.fromEntries(entries.map(([id, mailbox]) => [id, mailbox.unread])),
		folders: Object.fromEntries(entries.map(([id, mailbox]) => [id, mailbox.folders]))
	};
}

export const load: LayoutServerLoad = async ({ locals, depends, isDataRequest }) => {
	depends('mail:counts');
	const accounts = await listAccounts(locals.user.id);
	const stages = inStages<Mailbox>(
		accounts,
		async (account) => {
			const [unread, folders] = await Promise.all([
				inboxUnread(account),
				getFolders(account).catch(() => [])
			]);
			return { unread, folders };
		},
		() => ({ unread: null, folders: [] })
	);
	const early = stages.early.then(({ results }) => mailboxes(results));
	const late = stages.late.then((results) => results && mailboxes(results));
	const user = { name: locals.user.name, email: locals.user.email };
	// The first page streams the accounts that answered in time so the shell shows at once;
	// navigations and refreshes wait for them. Slower accounts follow in `lateMailboxes`.
	return {
		user,
		accounts: accounts.map(toSummary),
		mailboxes: isDataRequest ? await early : early,
		lateMailboxes: late
	};
};
