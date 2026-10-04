import { describe, expect, it } from 'vitest';
import type { MailAccount } from '../mail/types';
import { encodeMessageRef } from '../mail/message-ref';
import { levelAllows, McpAccess, McpAccessError } from './access';

const account = (id: string, email: string) => ({ id, email }) as MailAccount;
const access = new McpAccess([
	{ account: account('a', 'Read@example.com'), level: 'read' },
	{ account: account('b', 'full@example.com'), level: 'send' }
]);

describe('levelAllows', () => {
	it('treats levels as cumulative', () => {
		expect(levelAllows('send', 'read')).toBe(true);
		expect(levelAllows('organize', 'organize')).toBe(true);
		expect(levelAllows('organize', 'send')).toBe(false);
		expect(levelAllows('read', 'organize')).toBe(false);
	});
});

describe('McpAccess', () => {
	it('resolves granted accounts by ID or case-insensitive email', () => {
		expect(access.require('a', 'read').id).toBe('a');
		expect(access.require('read@EXAMPLE.com', 'read').id).toBe('a');
	});

	it('rejects ungranted accounts and insufficient levels with guidance', () => {
		expect(() => access.require('c', 'read')).toThrow(McpAccessError);
		expect(() => access.require('a', 'send')).toThrow(/Read only.*Full \(can send\)/);
	});

	it('filters accounts by level and checks message refs', () => {
		expect(access.accounts('send').map((a) => a.id)).toEqual(['b']);
		const ref = encodeMessageRef({ accountId: 'a', path: 'INBOX', uidValidity: '1', uid: 3 });
		expect(access.requireRef(ref, 'read').locator.uid).toBe(3);
		expect(() => access.requireRef(ref, 'organize')).toThrow(McpAccessError);
	});
});
