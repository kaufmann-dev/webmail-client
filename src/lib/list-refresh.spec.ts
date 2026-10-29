import { describe, expect, it } from 'vitest';
import { keptMailboxes, refreshedMessages } from './list-refresh';
import type { MessagePage, MessageSummary } from './mail-types';

function msg(accountId: string, id: number, date: string): MessageSummary {
	return {
		ref: `${accountId}:${id}`,
		accountId,
		cursor: id,
		from: null,
		to: [],
		subject: '',
		date,
		unread: false,
		starred: false,
		draft: false,
		hasAttachments: false,
		messageId: null
	};
}

function page(messages: MessageSummary[], pending: string[] = [], more = true): MessagePage {
	return { messages, nextCursor: more ? 'next' : null, errors: [], pending };
}

describe('refreshedMessages', () => {
	const shown = [
		msg('a', 3, '2026-10-05'),
		msg('s', 9, '2026-10-04'),
		msg('a', 2, '2026-10-03'),
		msg('a', 1, '2026-10-01')
	];

	it('keeps the shown messages of accounts still loading', () => {
		const next = page([msg('a', 4, '2026-10-06'), msg('a', 3, '2026-10-05')], ['s']);
		expect(refreshedMessages(next, shown, false).map((m) => m.ref)).toEqual(['a:4', 'a:3', 's:9']);
	});

	it('takes the new page alone when every account answered', () => {
		const next = page([msg('a', 3, '2026-10-05'), msg('s', 9, '2026-10-04')]);
		expect(refreshedMessages(next, shown, false)).toBe(next.messages);
	});

	it('keeps the pages below the new first page after "Load more"', () => {
		const next = page([msg('a', 4, '2026-10-06'), msg('s', 9, '2026-10-04')]);
		expect(refreshedMessages(next, shown, true).map((m) => m.ref)).toEqual([
			'a:4',
			's:9',
			'a:2',
			'a:1'
		]);
		// Messages newer than the page's last one that it lacks are gone; nothing below when it is all.
		expect(refreshedMessages(page(next.messages, [], false), shown, true)).toBe(next.messages);
	});
});

describe('keptMailboxes', () => {
	const shown = { unread: { a: 1, s: 4 }, folders: { a: ['inbox'], s: ['inbox', 'x'] } };

	it('keeps accounts the new mailboxes leave out', () => {
		const next = { unread: { a: 2 }, folders: { a: ['inbox'] } };
		expect(keptMailboxes(next, shown, ['a', 's'])).toEqual({
			unread: { a: 2, s: 4 },
			folders: { a: ['inbox'], s: ['inbox', 'x'] }
		});
	});

	it('drops accounts that no longer exist', () => {
		const next = { unread: { a: 2 }, folders: { a: ['inbox'] } };
		expect(keptMailboxes(next, shown, ['a'])).toBe(next);
		expect(keptMailboxes(next, null, ['a', 's'])).toBe(next);
	});
});
