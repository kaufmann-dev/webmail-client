import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../mail-types';
import { decodeCursor, encodeCursor, mergePages } from './merge';

function msg(accountId: string, uid: number, date: string): MessageSummary {
	return {
		ref: `${accountId}:${uid}`,
		accountId,
		uid,
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
				exhausted: false
			},
			{
				accountId: 'b',
				items: [msg('b', 5, '2026-10-03'), msg('b', 4, '2026-09-01')],
				exhausted: true
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
				exhausted: true
			},
			{ accountId: 'b', items: [msg('b', 3, '2026-10-01')], exhausted: true }
		];
		const first = mergePages(pages, 1, {});
		expect(first.messages.map((m) => m.ref)).toEqual(['b:3']);
		expect(first.cursor).toEqual({ b: 0 });
	});

	it('returns no cursor when every account is exhausted', () => {
		const pages = [{ accountId: 'a', items: [msg('a', 1, '2026-01-01')], exhausted: true }];
		expect(mergePages(pages, 10, {}).cursor).toBeNull();
	});

	it('round-trips cursors and ignores garbage', () => {
		expect(decodeCursor(encodeCursor({ a: 5, b: 0 }))).toEqual({ a: 5, b: 0 });
		expect(decodeCursor('%%%')).toEqual({});
		expect(decodeCursor(Buffer.from('{"a":-1,"b":"x"}').toString('base64url'))).toEqual({});
	});
});
