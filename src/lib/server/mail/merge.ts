import type { MessageSummary } from '../../mail-types';

/**
 * Per-account paging state for merged lists: the UID below which the next page starts, or 0 when
 * the account has nothing more. Accounts missing from the map start at the newest message.
 */
export type ListCursor = Record<string, number>;

export interface AccountPage {
	accountId: string;
	/** Newest first (descending UID). */
	items: MessageSummary[];
	/** True when no messages exist below the last item. */
	exhausted: boolean;
}

export function encodeCursor(cursor: ListCursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string | null | undefined): ListCursor {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(([, uid]) => Number.isSafeInteger(uid) && (uid as number) >= 0)
		) as ListCursor;
	} catch {
		return {};
	}
}

const time = (message: MessageSummary) => Date.parse(message.date) || 0;

/**
 * K-way merge of per-account pages by date. Each account's page is consumed strictly from its
 * newest UID downwards, so the next cursor (the lowest consumed UID) never skips a message, even
 * when dates and UIDs disagree.
 */
export function mergePages(
	pages: AccountPage[],
	limit: number,
	previous: ListCursor
): { messages: MessageSummary[]; cursor: ListCursor | null } {
	const positions = pages.map(() => 0);
	const messages: MessageSummary[] = [];
	while (messages.length < limit) {
		let best = -1;
		for (let i = 0; i < pages.length; i++) {
			const head = pages[i].items[positions[i]];
			if (head && (best < 0 || time(head) > time(pages[best].items[positions[best]]))) best = i;
		}
		if (best < 0) break;
		messages.push(pages[best].items[positions[best]++]);
	}

	const cursor: ListCursor = { ...previous };
	for (const [i, page] of pages.entries()) {
		const consumed = positions[i];
		if (consumed === page.items.length && page.exhausted) cursor[page.accountId] = 0;
		else if (consumed > 0) cursor[page.accountId] = page.items[consumed - 1].uid;
	}
	const more = pages.some((page) => cursor[page.accountId] !== 0);
	return { messages, cursor: more ? cursor : null };
}
