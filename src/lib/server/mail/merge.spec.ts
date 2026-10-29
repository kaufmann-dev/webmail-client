import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../mail-types';
import { decodeCursor, encodeCursor, mergePages, trimPage } from './merge';

function msg(accountId: string, uid: number, date: string): MessageSummary {
	return {
		ref: `${accountId}:${uid}`,
		accountId,
		cursor: uid,
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

describe('mergePages', () => {
	it('orders by date across accounts and advances each cursor by what it consumed', () => {
		const pages = [
			{
				accountId: 'a',
				items: [msg('a', 9, '2026-10-04'), msg('a', 8, '2026-10-01')],
				exhausted: false,
				last: 8
			},
			{
				accountId: 'b',
				items: [msg('b', 5, '2026-10-03'), msg('b', 4, '2026-09-01')],
				exhausted: true,
				last: 4
			}
		];
		const { messages, cursor } = mergePages(pages, 3, {});
		expect(messages.map((m) => m.ref)).toEqual(['a:9', 'b:5', 'a:8']);
		expect(cursor).toEqual({ a: 8, b: 5 });
	});

	it('never skips a message whose date is older than a lower UID', () => {
		// UID 7 has an old date (e.g. an imported message) but must not be skipped by the cursor.
		const pages = [
			{
				accountId: 'a',
				items: [msg('a', 7, '2020-01-01'), msg('a', 6, '2026-10-02')],
				exhausted: true,
				last: 6
			},
			{ accountId: 'b', items: [msg('b', 3, '2026-10-01')], exhausted: true, last: 3 }
		];
		const first = mergePages(pages, 1, {});
		expect(first.messages.map((m) => m.ref)).toEqual(['b:3']);
		expect(first.cursor).toEqual({ b: 0 });
	});

	it('returns no cursor when every account is exhausted', () => {
		const pages = [
			{ accountId: 'a', items: [msg('a', 1, '2026-01-01')], exhausted: true, last: 1 }
		];
		expect(mergePages(pages, 10, {}).cursor).toBeNull();
	});

	it('keeps accounts seeded as done out of further pages', () => {
		const pages = [
			{ accountId: 'a', items: [msg('a', 2, '2026-01-02')], exhausted: false, last: 2 }
		];
		expect(mergePages(pages, 10, { b: 0 }).cursor).toEqual({ a: 2, b: 0 });
		const done = [{ accountId: 'a', items: [msg('a', 1, '2026-01-01')], exhausted: true, last: 1 }];
		expect(mergePages(done, 10, { b: 0 }).cursor).toBeNull();
	});

	it('continues past messages the page left out', () => {
		// The server returned UIDs 5 to 3; 4 and 3 were left out (e.g. outside a time window).
		const partly = [
			{ accountId: 'a', items: [msg('a', 5, '2026-01-05')], exhausted: false, last: 3 }
		];
		expect(mergePages(partly, 10, {}).cursor).toEqual({ a: 3 });
		const none = [{ accountId: 'a', items: [], exhausted: false, last: 3 }];
		expect(mergePages(none, 10, { a: 6 }).cursor).toEqual({ a: 3 });
	});

	it('round-trips cursors and ignores garbage', () => {
		expect(decodeCursor(encodeCursor({ a: 5, b: 0 }))).toEqual({ a: 5, b: 0 });
		expect(decodeCursor('%%%')).toEqual({});
		expect(decodeCursor(Buffer.from('{"a":-1,"b":"x"}').toString('base64url'))).toEqual({});
	});
});

describe('trimPage', () => {
	const page = {
		accountId: 'a',
		items: [msg('a', 9, '2026-10-10T12:00:00Z'), msg('a', 8, '2026-10-09T08:00:00Z')],
		exhausted: false,
		last: 8
	};

	it('drops messages received before the window and ends a page ordered by time', () => {
		const trimmed = trimPage(page, new Date('2026-10-09T09:00:00Z'), true);
		expect(trimmed.items.map((m) => m.ref)).toEqual(['a:9']);
		expect(trimmed.exhausted).toBe(true);
	});

	it('keeps paging when the page runs by UID', () => {
		const trimmed = trimPage(page, new Date('2026-10-09T09:00:00Z'), false);
		expect(trimmed.items.map((m) => m.ref)).toEqual(['a:9']);
		expect(trimmed.exhausted).toBe(false);
		expect(trimmed.last).toBe(8);
	});

	it('leaves a page inside the window unchanged', () => {
		expect(trimPage(page, new Date('2026-10-01T00:00:00Z'), true)).toBe(page);
	});
});
