import { describe, expect, it } from 'vitest';
import type { MessageSummary, ThreadKeys } from '../../mail-types';
import { groupConversations } from './conversations';
import { conversationCriteria, referencesOf } from './messages';

function message(
	ref: string,
	date: string,
	keys: Partial<ThreadKeys> & { messageId?: string; from?: string } = {}
): MessageSummary {
	return {
		ref,
		accountId: 'a',
		cursor: 0,
		from: { name: '', address: keys.from ?? 'anna@example.com' },
		to: [],
		subject: 'Termin',
		date,
		unread: false,
		starred: false,
		draft: false,
		hasAttachments: false,
		messageId: keys.messageId ?? `<${ref}@example.com>`,
		thread: {
			id: keys.id ?? null,
			inReplyTo: keys.inReplyTo ?? null,
			references: keys.references ?? []
		}
	};
}

describe('groupConversations', () => {
	it('links IMAP messages by Message-ID, In-Reply-To, and References', () => {
		const first = message('m1', '2026-10-01T08:00:00Z');
		const second = message('m2', '2026-10-03T08:00:00Z', {
			inReplyTo: '<sent1@example.com>',
			references: ['<m1@example.com>', '<sent1@example.com>']
		});
		const other = message('m3', '2026-10-02T08:00:00Z');
		const sent = message('sent1', '2026-10-02T09:00:00Z', {
			from: 'me@example.com',
			inReplyTo: '<m1@example.com>',
			references: ['<m1@example.com>']
		});
		const unrelatedSent = message('sent2', '2026-10-04T08:00:00Z', { from: 'me@example.com' });
		const groups = groupConversations([second, other, first], [sent, unrelatedSent]);
		expect(groups.map((g) => g.listed.map((m) => m.ref))).toEqual([['m2', 'm1'], ['m3']]);
		expect(groups[0].messages.map((m) => m.ref)).toEqual(['m1', 'sent1', 'm2']);
	});

	it('groups by the provider conversation ID and shows when the user answered last', () => {
		const received = message('e1', '2026-10-01T08:00:00Z', { id: 'conv-1' });
		const reply = message('e2', '2026-10-01T10:00:00Z', { id: 'conv-1', from: 'me@example.com' });
		const [group] = groupConversations([received], [reply]);
		expect(group.listed).toEqual([received]);
		expect(group.messages.at(-1)?.from?.address).toBe('me@example.com');
	});

	it('keeps provider conversations apart even when headers link them', () => {
		const request = message('g1', '2026-10-09T07:00:00Z', { id: 'thread-a' });
		const ticket = message('g2', '2026-10-09T07:26:00Z', {
			id: 'thread-b',
			references: ['<g1@example.com>']
		});
		expect(groupConversations([ticket, request]).map((g) => g.listed.length)).toEqual([1, 1]);
	});

	it('counts a message sent to oneself once', () => {
		const copy = message('in', '2026-10-01T08:00:00Z', { messageId: '<self@example.com>' });
		const sent = message('out', '2026-10-01T08:00:00Z', { messageId: '<self@example.com>' });
		expect(groupConversations([copy], [sent])[0].messages).toEqual([copy]);
	});
});

describe('referencesOf', () => {
	it('reads the Message-IDs of a folded References header', () => {
		const header = Buffer.from('References: <a@x.org>\r\n <b@y.org> <c@z.org>\r\n\r\n');
		expect(referencesOf(header)).toEqual(['<a@x.org>', '<b@y.org>', '<c@z.org>']);
		expect(referencesOf(undefined)).toEqual([]);
	});
});

describe('conversationCriteria', () => {
	it('finds ancestors by Message-ID and replies by References or only In-Reply-To', () => {
		const criteria = conversationCriteria([
			{ messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'] },
			{ messageId: '<c@x>', inReplyTo: null, references: [] }
		]);
		expect(criteria).toEqual([
			{ header: { 'message-id': '<a@x>' } },
			{ header: { 'message-id': '<b@x>' } },
			{ header: { references: '<b@x>' } },
			{ header: { 'in-reply-to': '<b@x>' } },
			{ header: { 'message-id': '<c@x>' } },
			{ header: { references: '<c@x>' } },
			{ header: { 'in-reply-to': '<c@x>' } }
		]);
	});
});
