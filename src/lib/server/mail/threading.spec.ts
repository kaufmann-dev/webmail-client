import { describe, expect, it } from 'vitest';
import {
	baseSubject,
	composeBody,
	forwardSubject,
	forwardedBlock,
	looksLikeReplySubject,
	quoteOriginal,
	replyRecipients,
	replyReferences,
	replySubject,
	type OriginalMessage
} from './threading';

const alice = { name: 'Alice', address: 'alice@example.com' };
const bob = { name: 'Bob', address: 'bob@example.com' };
const me = { name: 'Me', address: 'me@kaufmann.dev' };
const carol = { name: '', address: 'carol@example.com' };

const original: OriginalMessage = {
	messageId: '<m3@example.com>',
	references: ['<m1@example.com>', '<m2@example.com>'],
	subject: 'AW: Re: Project plan',
	from: alice,
	replyTo: [],
	to: [me, bob],
	cc: [carol],
	date: new Date('2026-10-01T10:00:00Z'),
	text: 'Line one\n> earlier quote'
};

describe('subjects', () => {
	it('normalizes stacked prefixes to exactly one', () => {
		expect(baseSubject('Re: Re: AW: Fwd: x')).toBe('x');
		expect(replySubject('Re: RE: AW: x')).toBe('Re: x');
		expect(replySubject('Re[2]: WG: x')).toBe('Re: x');
		expect(forwardSubject('Re: x')).toBe('Fwd: x');
		expect(replySubject('Report: Q3')).toBe('Re: Report: Q3');
	});

	it('detects reply subjects', () => {
		expect(looksLikeReplySubject('Re: hi')).toBe(true);
		expect(looksLikeReplySubject('AW: hi')).toBe(true);
		expect(looksLikeReplySubject('Reminder: hi')).toBe(false);
	});
});

describe('replyReferences', () => {
	it('appends the original Message-ID to its references', () => {
		expect(replyReferences(original)).toEqual([
			'<m1@example.com>',
			'<m2@example.com>',
			'<m3@example.com>'
		]);
	});

	it('keeps the root and the latest ancestors of long chains', () => {
		const references = Array.from({ length: 30 }, (_, i) => `<r${i}@x>`);
		const result = replyReferences({ messageId: '<last@x>', references });
		expect(result).toHaveLength(20);
		expect(result[0]).toBe('<r0@x>');
		expect(result.at(-1)).toBe('<last@x>');
	});
});

describe('replyRecipients', () => {
	it('replies to the sender only, or Reply-To when set', () => {
		expect(replyRecipients(original, [me.address], false)).toEqual({ to: [alice], cc: [] });
		const withReplyTo = { ...original, replyTo: [{ name: 'List', address: 'list@example.com' }] };
		expect(replyRecipients(withReplyTo, [me.address], false).to).toEqual([withReplyTo.replyTo[0]]);
	});

	it('copies other recipients on reply-all, excluding own addresses and duplicates', () => {
		const result = replyRecipients(
			{ ...original, cc: [carol, { name: 'ME', address: 'ME@kaufmann.dev' }, alice] },
			[me.address],
			true
		);
		expect(result).toEqual({ to: [alice], cc: [bob, carol] });
	});

	it('replies to the original recipients of a message the account sent itself', () => {
		const sent = { ...original, from: me, to: [bob], cc: [carol] };
		expect(replyRecipients(sent, [me.address], false)).toEqual({ to: [bob], cc: [] });
		expect(replyRecipients(sent, [me.address], true)).toEqual({ to: [bob], cc: [carol] });
	});
});

describe('bodies', () => {
	it('quotes the original with an attribution line', () => {
		const quoted = quoteOriginal(original);
		expect(quoted).toMatch(/^On .+, Alice <alice@example.com> wrote:\n> Line one\n>> earlier/);
	});

	it('puts text, signature delimiter, and quote in order', () => {
		expect(composeBody('Hi', 'David', '> q')).toBe('Hi\n\n-- \nDavid\n\n> q');
		expect(composeBody('Hi', null)).toBe('Hi');
	});

	it('includes original headers in forwards', () => {
		const block = forwardedBlock(original);
		expect(block).toContain('From: Alice <alice@example.com>');
		expect(block).toContain('Cc: carol@example.com');
		expect(block.endsWith('Line one\n> earlier quote')).toBe(true);
	});
});
