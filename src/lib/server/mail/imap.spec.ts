import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailError } from './errors';
import { withMailbox } from './imap';
import type { MailAccount } from './types';

const clients = vi.hoisted(() => [] as { usable: boolean; lockError: unknown }[]);
let firstLockError: unknown = null;

vi.mock('imapflow', () => ({
	ImapFlow: class {
		usable = true;
		mailbox = { path: 'INBOX' };
		lockError: unknown;
		constructor() {
			this.lockError = clients.length === 0 ? firstLockError : null;
			clients.push(this);
		}
		on() {}
		close() {
			this.usable = false;
		}
		async connect() {}
		async getMailboxLock() {
			if (this.lockError) {
				this.usable = false;
				throw this.lockError;
			}
			return { release() {} };
		}
	}
}));
vi.mock('./credentials', () => ({ mailAuth: async () => ({}) }));
vi.mock('./account-status', () => ({
	recordAccountError: async () => {},
	clearAccountError: async () => {}
}));

const account = (id: string) =>
	({ id, email: `${id}@example.com`, provider: 'gmail' }) as MailAccount;

describe('withMailbox', () => {
	beforeEach(() => {
		clients.length = 0;
	});

	it('retries on a new connection when the connection closed while waiting for the lock', async () => {
		firstLockError = Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
		const result = await withMailbox(account('closed'), 'INBOX', async (client) =>
			clients.indexOf(client as never)
		);
		expect(result).toBe(1);
		expect(clients).toHaveLength(2);
	});

	it('does not retry other lock failures', async () => {
		firstLockError = Object.assign(new Error('Timed out waiting for mailbox lock'), {
			code: 'LockTimeout'
		});
		await expect(withMailbox(account('timeout'), 'INBOX', async () => 'ran')).rejects.toThrow(
			MailError
		);
		expect(clients).toHaveLength(1);
	});
});
