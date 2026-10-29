import type { MessageSummary } from './mail-types';

export type Flags = Partial<Pick<MessageSummary, 'unread' | 'starred'>>;

export interface Change {
	refs: Set<string>;
	/** The messages that leave the list. */
	removed: Set<string>;
	flags: Flags;
	/** Inbox unread count changes by account. */
	unread: Record<string, number>;
	/** The server time it finished; null while it runs. */
	done: number | null;
}

/**
 * The message actions of this tab. They live outside the mail page, so a page that remounts while
 * one runs (after the editor or settings opened) still shows it; only event handlers change them,
 * never server rendering.
 */
class MailActions {
	/**
	 * Actions show at once and run in the background. A finished change stays applied until data
	 * the server began loading after it finished arrives (`listedAt`, `countedAt`), so data already
	 * on its way, however it was requested, cannot undo it.
	 */
	changes = $state.raw<Change[]>([]);
	/** Actions reach the server in the order they were made, so the last one on a message wins. */
	queue: Promise<unknown> = Promise.resolve();
}

export const mailActions = new MailActions();
