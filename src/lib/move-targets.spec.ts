import { describe, expect, it } from 'vitest';
import { canMoveTo, moveDestinations, type FolderEntry } from './move-targets';

const folders: Record<string, FolderEntry[]> = {
	a: [
		{ path: 'INBOX', name: 'INBOX', depth: 0, role: 'inbox' },
		{ path: 'Drafts', name: 'Drafts', depth: 0, role: 'drafts' },
		{ path: 'Trash', name: 'Trash', depth: 0, role: 'trash' },
		{ path: 'Projects', name: 'Projects', depth: 0, role: null }
	],
	b: [{ path: 'INBOX', name: 'INBOX', depth: 0, role: 'inbox' }]
};

describe('canMoveTo', () => {
	const inbox = { role: 'inbox' as const, folder: 'inbox' };

	it('keeps messages within their account', () => {
		const projects = { accountId: 'a', key: 'Projects', role: null };
		expect(canMoveTo(projects, new Set(['a']), inbox)).toBe(true);
		expect(canMoveTo(projects, new Set(['a', 'b']), inbox)).toBe(false);
		expect(
			canMoveTo({ accountId: null, key: 'trash', role: 'trash' }, new Set(['a', 'b']), inbox)
		).toBe(true);
	});

	it('rejects Drafts and the viewed folder', () => {
		const ids = new Set(['a']);
		expect(canMoveTo({ accountId: 'a', key: 'drafts', role: 'drafts' }, ids, inbox)).toBe(false);
		expect(canMoveTo({ accountId: 'a', key: 'inbox', role: 'inbox' }, ids, inbox)).toBe(false);
		expect(
			canMoveTo({ accountId: 'a', key: 'Projects', role: null }, ids, {
				role: null,
				folder: 'Projects'
			})
		).toBe(false);
	});
});

describe('moveDestinations', () => {
	const view = { role: 'inbox' as const, folder: 'inbox' };

	it("lists one account's folders", () => {
		expect(moveDestinations(folders, new Set(['a']), view).map((d) => d.key)).toEqual([
			'trash',
			'Projects'
		]);
	});

	it('lists shared roles across accounts', () => {
		expect(moveDestinations(folders, new Set(['a', 'b']), view).map((d) => d.key)).toEqual([
			'sent',
			'archive',
			'spam',
			'trash'
		]);
	});
});
