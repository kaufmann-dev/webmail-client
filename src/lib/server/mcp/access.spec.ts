import { describe, expect, it, vi } from 'vitest';
import type { MessageDetail } from '../../mail-types';
import { encodeMessageRef, type MessageLocator } from '../mail/message-ref';
import type { ReadMessage } from '../mail/messages';
import type { MailAccount } from '../mail/types';
import { levelAllows, McpAccess, McpAccessError, type Grant, type MessageSource } from './access';

const DAY_MS = 24 * 60 * 60_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

const account = (id: string, email: string) => ({ id, email }) as MailAccount;

function grant(id: string, email: string, overrides: Partial<Grant> = {}): Grant {
	return {
		account: account(id, email),
		level: 'read',
		maxAgeDays: null,
		allowAttachments: true,
		...overrides
	};
}

function ref(accountId: string, uid: number): string {
	return encodeMessageRef({ kind: 'imap', accountId, path: 'INBOX', uidValidity: '1', uid });
}

/** Messages by ref with their received dates; reading returns a detail with that date. */
function source(dates: Record<string, string>): MessageSource {
	return {
		read: vi.fn(async (_account: MailAccount, locator: MessageLocator) => {
			const date = dates[encodeMessageRef(locator)];
			return { detail: { date } as MessageDetail, sentAt: null, calendar: null } as ReadMessage;
		}),
		receivedDates: vi.fn(async (_account: MailAccount, locators: MessageLocator[]) => {
			const found = new Map<string, string>();
			for (const locator of locators) {
				const key = encodeMessageRef(locator);
				if (dates[key]) found.set(key, dates[key]);
			}
			return found;
		})
	};
}

describe('levelAllows', () => {
	it('treats levels as cumulative', () => {
		expect(levelAllows('send', 'read')).toBe(true);
		expect(levelAllows('organize', 'organize')).toBe(true);
		expect(levelAllows('organize', 'send')).toBe(false);
		expect(levelAllows('read', 'organize')).toBe(false);
	});
});

describe('McpAccess accounts', () => {
	const access = new McpAccess([
		grant('a', 'Read@example.com'),
		grant('b', 'full@example.com', { level: 'send' })
	]);

	it('resolves granted accounts by ID or case-insensitive email', () => {
		expect(access.require('a', 'read').id).toBe('a');
		expect(access.require('read@EXAMPLE.com', 'read').id).toBe('a');
	});

	it('rejects ungranted accounts and insufficient levels with guidance', () => {
		expect(() => access.require('c', 'read')).toThrow(McpAccessError);
		expect(() => access.require('a', 'send')).toThrow(/Read only.*Full \(can send\)/);
	});

	it('filters accounts by level', () => {
		expect(access.accounts('send').map((a) => a.id)).toEqual(['b']);
	});
});

describe('McpAccess time window', () => {
	const windowed = grant('a', 'work@example.com', { maxAgeDays: 30 });
	const unlimited = grant('b', 'home@example.com');

	it('allows messages inside the window and refuses older ones', () => {
		const access = new McpAccess([windowed, unlimited]);
		expect(access.inWindow(windowed, daysAgo(29))).toBe(true);
		expect(access.inWindow(windowed, daysAgo(31))).toBe(false);
	});

	it('allows messages of any age without a limit', () => {
		const access = new McpAccess([windowed, unlimited]);
		expect(access.cutoff(unlimited)).toBeNull();
		expect(access.inWindow(unlimited, '2001-01-01T00:00:00.000Z')).toBe(true);
	});

	it('reads a message inside the window', async () => {
		const received = daysAgo(2);
		const access = new McpAccess([windowed], source({ [ref('a', 1)]: received }));
		const { account, read } = await access.requireMessage(ref('a', 1), 'read');
		expect(account.id).toBe('a');
		expect(read.detail.date).toBe(received);
	});

	it('refuses a message outside the window and names the limit', async () => {
		const access = new McpAccess([windowed], source({ [ref('a', 1)]: daysAgo(45) }));
		await expect(access.requireMessage(ref('a', 1), 'read')).rejects.toThrow(
			'work@example.com only allows this connection to access messages from the last 30 days.'
		);
	});

	it('checks the level before reading the message', async () => {
		const messages = source({ [ref('a', 1)]: daysAgo(1) });
		const access = new McpAccess([windowed], messages);
		await expect(access.requireMessage(ref('a', 1), 'send')).rejects.toThrow(McpAccessError);
		expect(messages.read).not.toHaveBeenCalled();
	});

	it('checks bulk actions by received date only', async () => {
		const messages = source({ [ref('a', 1)]: daysAgo(1), [ref('a', 2)]: daysAgo(60) });
		const access = new McpAccess([{ ...windowed, level: 'organize' }], messages);
		await expect(access.requireMessages([ref('a', 1)], 'organize')).resolves.toBeUndefined();
		await expect(access.requireMessages([ref('a', 1), ref('a', 2)], 'organize')).rejects.toThrow(
			/last 30 days/
		);
		// A message that no longer exists has no date; the action itself leaves it alone.
		await expect(access.requireMessages([ref('a', 3)], 'organize')).resolves.toBeUndefined();
		expect(messages.read).not.toHaveBeenCalled();
	});

	it('skips the date lookup for accounts without a window', async () => {
		const messages = source({});
		const access = new McpAccess([{ ...unlimited, level: 'organize' }], messages);
		await access.requireMessages([ref('b', 1)], 'organize');
		expect(messages.receivedDates).not.toHaveBeenCalled();
	});

	it('gives lists the windows of their accounts and filters threads', () => {
		const access = new McpAccess([windowed, unlimited]);
		const notBefore = access.notBefore([windowed.account, unlimited.account]);
		expect([...notBefore.keys()]).toEqual(['a']);
		expect(Date.now() - notBefore.get('a')!.getTime()).toBeCloseTo(30 * DAY_MS, -4);
		const [old, recent, otherAccount] = [
			{ accountId: 'a', date: daysAgo(40) },
			{ accountId: 'a', date: daysAgo(3) },
			{ accountId: 'b', date: daysAgo(400) }
		] as Parameters<typeof access.visible>[0];
		expect(access.visible([old, recent, otherAccount])).toEqual([recent, otherAccount]);
	});
});

describe('McpAccess attachments', () => {
	it('refuses attachment access without reading the message', async () => {
		const messages = source({ [ref('a', 1)]: daysAgo(1) });
		const access = new McpAccess(
			[grant('a', 'work@example.com', { allowAttachments: false })],
			messages
		);
		await expect(
			access.requireMessage(ref('a', 1), 'read', {
				attachments: true,
				attachmentsHint: 'Forward with include_attachments set to false instead.'
			})
		).rejects.toThrow(
			'work@example.com does not allow this connection to read attachments. Forward with include_attachments set to false instead.'
		);
		expect(messages.read).not.toHaveBeenCalled();
	});

	it('still allows reading the message itself', async () => {
		const access = new McpAccess(
			[grant('a', 'work@example.com', { allowAttachments: false })],
			source({ [ref('a', 1)]: daysAgo(1) })
		);
		const { grant: found } = await access.requireMessage(ref('a', 1), 'read');
		expect(found.allowAttachments).toBe(false);
	});

	it('allows attachments when the grant does', async () => {
		const access = new McpAccess(
			[grant('a', 'work@example.com')],
			source({ [ref('a', 1)]: daysAgo(1) })
		);
		await expect(
			access.requireMessage(ref('a', 1), 'read', { attachments: true })
		).resolves.toMatchObject({ account: { id: 'a' } });
	});
});
