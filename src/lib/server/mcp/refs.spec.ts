import { describe, expect, it } from 'vitest';
import { encodeMessageRef, InvalidMessageRefError } from '../mail/message-ref';
import { movedImapRefs } from '../mail/messages';
import type { MailAccount } from '../mail/types';
import { McpRefs, newRefId, type RefRow, type RefStore } from './refs';

/** The database store's behavior, in memory. */
function memoryStore(): RefStore & { rows: (RefRow & { userId: string })[] } {
	const rows: (RefRow & { userId: string })[] = [];
	return {
		rows,
		async mint(userId, entries) {
			const ids = new Map<string, string>();
			for (const entry of entries) {
				let row = rows.find((r) => r.userId === userId && r.locator === entry.locator);
				if (!row) rows.push((row = { ...entry, id: newRefId(), userId }));
				ids.set(row.locator, row.id);
			}
			return ids;
		},
		async find(userId, ids) {
			return rows.filter((r) => r.userId === userId && ids.includes(r.id));
		},
		async forAccount(userId, accountId) {
			return rows.filter((r) => r.userId === userId && r.accountId === accountId);
		},
		async relocate(userId, moves, keep = false) {
			const applied = new Set<string>();
			for (const [from, to] of moves) {
				const taken = rows.findIndex((r) => r.userId === userId && r.locator === to);
				if (taken >= 0 && keep) continue;
				if (taken >= 0) rows.splice(taken, 1);
				const row = rows.find((r) => r.userId === userId && r.locator === from);
				if (row) row.locator = to;
				applied.add(from);
			}
			return applied;
		},
		async forgetMessageIds(userId, locators) {
			for (const row of rows) {
				if (row.userId === userId && locators.includes(row.locator)) row.messageId = null;
			}
		}
	};
}

const account = { id: 'acc', email: 'me@example.com' } as MailAccount;
const inboxRef = (uid: number) =>
	encodeMessageRef({ kind: 'imap', accountId: 'acc', path: 'INBOX', uidValidity: '7', uid });

describe('McpRefs', () => {
	it('gives each message one short ref', async () => {
		const refs = new McpRefs('u1', memoryStore());
		const first = await refs.shorten([{ ref: inboxRef(1), accountId: 'acc', messageId: '<1@x>' }]);
		const again = await refs.shorten([{ ref: inboxRef(1), accountId: 'acc', messageId: '<1@x>' }]);
		const id = first.get(inboxRef(1))!;
		expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
		expect(again.get(inboxRef(1))).toBe(id);
		expect((await refs.resolve(id)).locator).toBe(inboxRef(1));
	});

	it('keeps a ref valid after the message moved', async () => {
		const refs = new McpRefs('u1', memoryStore());
		const id = (await refs.shorten([{ ref: inboxRef(42), accountId: 'acc', messageId: null }])).get(
			inboxRef(42)
		)!;
		const moved = movedImapRefs(
			{ kind: 'imap', account, path: 'INBOX', uidValidity: '7', uids: [42] },
			{ destination: 'Archive', uidValidity: 99n, uidMap: new Map([[42, 5]]) }
		);
		await refs.moved(moved);
		expect(decodeLocator((await refs.resolve(id)).locator)).toEqual(['acc', 'Archive', '99', 5]);
	});

	it('follows a renamed or moved folder in the same account only', async () => {
		const ref = (accountId: string, path: string) =>
			encodeMessageRef({ kind: 'imap', accountId, path, uidValidity: '7', uid: 1 });
		const refs = new McpRefs('u1', memoryStore());
		const short = await refs.shorten([
			{ ref: ref('acc', 'Work/Old'), accountId: 'acc', messageId: null },
			{ ref: ref('acc', 'Work2'), accountId: 'acc', messageId: null },
			{ ref: ref('other', 'Work'), accountId: 'other', messageId: null }
		]);
		await refs.folderMoved('acc', 'Work', 'Jobs', '/');
		const locator = async (r: string) => (await refs.resolve(short.get(r)!)).locator;
		expect(await locator(ref('acc', 'Work/Old'))).toBe(ref('acc', 'Jobs/Old'));
		expect(await locator(ref('acc', 'Work2'))).toBe(ref('acc', 'Work2'));
		expect(await locator(ref('other', 'Work'))).toBe(ref('other', 'Work'));
	});

	it('scopes refs to their user and rejects unknown ones', async () => {
		const store = memoryStore();
		const id = (
			await new McpRefs('u1', store).shorten([
				{ ref: inboxRef(1), accountId: 'acc', messageId: null }
			])
		).get(inboxRef(1))!;
		await expect(new McpRefs('u2', store).resolve(id)).rejects.toThrow(InvalidMessageRefError);
		await expect(new McpRefs('u1', store).resolveAll([id, 'nope'])).rejects.toThrow(/nope/);
	});

	it('follows a message found again only onto a message without a ref of its own', async () => {
		const refs = new McpRefs('u1', memoryStore());
		const ids = await refs.shorten([
			{ ref: inboxRef(1), accountId: 'acc', messageId: '<1@x>' },
			{ ref: inboxRef(2), accountId: 'acc', messageId: '<1@x>' }
		]);
		const followed = await refs.followed(
			new Map([
				[inboxRef(1), inboxRef(2)],
				[inboxRef(3), inboxRef(4)]
			])
		);
		expect(followed).toEqual(new Set([inboxRef(3)]));
		// The copy keeps its own ref, and the ref of the message that is gone is left alone.
		expect((await refs.resolve(ids.get(inboxRef(2))!)).locator).toBe(inboxRef(2));
		expect((await refs.resolve(ids.get(inboxRef(1))!)).locator).toBe(inboxRef(1));
	});

	it('stops looking up gone messages by their Message-ID', async () => {
		const refs = new McpRefs('u1', memoryStore());
		const id = (
			await refs.shorten([{ ref: inboxRef(1), accountId: 'acc', messageId: '<1@x>' }])
		).get(inboxRef(1))!;
		await refs.gone([inboxRef(1)]);
		expect((await refs.resolve(id)).messageId).toBeNull();
	});
});

describe('movedImapRefs', () => {
	it('reports nothing without UIDPLUS', () => {
		const group = { kind: 'imap' as const, account, path: 'INBOX', uidValidity: '7', uids: [1] };
		expect(movedImapRefs(group, { destination: 'Archive' }).size).toBe(0);
	});
});

function decodeLocator(ref: string): unknown {
	return JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
}
