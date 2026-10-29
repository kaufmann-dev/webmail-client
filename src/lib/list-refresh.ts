import type { MessagePage, MessageSummary } from './mail-types';

const time = (message: MessageSummary) => Date.parse(message.date) || 0;

/**
 * The messages to show when a new list of the view on screen arrives (a refresh, or its late
 * stage), newest first: its first page; the shown messages of accounts it still waits for, until
 * they answer; and after "Load more" (`keepBelow`), the shown messages below its first page, so the
 * place in the list stays.
 */
export function refreshedMessages(
	next: MessagePage,
	shown: MessageSummary[],
	keepBelow: boolean
): MessageSummary[] {
	const pending = new Set(next.pending);
	const fresh = new Set(next.messages.map((m) => m.ref));
	const below = keepBelow && next.nextCursor !== null;
	const oldest = next.messages.length ? time(next.messages[next.messages.length - 1]) : -Infinity;
	const kept = shown.filter(
		(m) => !fresh.has(m.ref) && (pending.has(m.accountId) || (below && time(m) <= oldest))
	);
	if (!kept.length) return next.messages;
	return [...next.messages, ...kept].sort((a, b) => time(b) - time(a));
}

interface Mailboxes {
	unread: Record<string, number | null>;
	folders: Record<string, unknown[]>;
}

/**
 * Folders and unread counts to show when new ones arrive: accounts the new ones leave out (slow to
 * answer this time) keep what was shown for them, as long as they still exist.
 */
export function keptMailboxes<T extends Mailboxes>(
	next: T,
	shown: T | null,
	accountIds: string[]
): T {
	if (!shown) return next;
	const missing = accountIds.filter((id) => !(id in next.folders) && id in shown.folders);
	if (!missing.length) return next;
	return {
		...next,
		unread: { ...next.unread, ...Object.fromEntries(missing.map((id) => [id, shown.unread[id]])) },
		folders: {
			...next.folders,
			...Object.fromEntries(missing.map((id) => [id, shown.folders[id]]))
		}
	};
}
