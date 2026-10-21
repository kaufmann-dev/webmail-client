import { describe, expect, it } from 'vitest';
import { isWithin, nestFolders, renamedPath, visibleTree } from './folder-tree';

const folders = [
	{ key: 'Projects', depth: 0 },
	{ key: 'Projects/Alpha', depth: 1 },
	{ key: 'Projects/Alpha/Notes', depth: 2 },
	{ key: 'Projects/Beta', depth: 1 },
	{ key: 'Receipts', depth: 0 }
];

const keys = (rows: ReturnType<typeof visibleTree>) => rows.map((row) => row.item.key);

describe('visibleTree', () => {
	it('shows every folder and marks parents while nothing is collapsed', () => {
		const rows = visibleTree(folders, new Set(), 'inbox');
		expect(keys(rows)).toEqual(folders.map((f) => f.key));
		expect(rows.map((row) => row.hasChildren)).toEqual([true, true, false, false, false]);
		expect(rows[0].expanded).toBe(true);
	});

	it('hides all subfolders of a collapsed folder', () => {
		const rows = visibleTree(folders, new Set(['Projects']), 'inbox');
		expect(keys(rows)).toEqual(['Projects', 'Receipts']);
		expect(rows[0].expanded).toBe(false);
		expect(keys(visibleTree(folders, new Set(['Projects/Alpha']), 'inbox'))).toEqual([
			'Projects',
			'Projects/Alpha',
			'Projects/Beta',
			'Receipts'
		]);
	});

	it('keeps a collapsed folder open while it holds the active folder', () => {
		const rows = visibleTree(folders, new Set(['Projects']), 'Projects/Alpha/Notes');
		expect(keys(rows)).toContain('Projects/Alpha/Notes');
		expect(rows[0].expanded).toBe(true);
	});
});

describe('nestFolders', () => {
	const nested = (entries: { path: string; name: string; depth: number }[]) =>
		nestFolders(entries).map(({ folder, depth }) => [folder.path, depth]);

	it('places subfolders of role folders below them, after the other role folders', () => {
		expect(
			nested([
				{ path: 'Inbox', name: 'Inbox', depth: 0 },
				{ path: 'Trash', name: 'Trash', depth: 0 },
				{ path: 'Trash/Old', name: 'Old', depth: 1 },
				{ path: 'Inbox/Projects', name: 'Projects', depth: 1 },
				{ path: 'Inbox/Projects/Alpha', name: 'Alpha', depth: 2 },
				{ path: 'Receipts', name: 'Receipts', depth: 0 }
			])
		).toEqual([
			['Inbox', 0],
			['Inbox/Projects', 1],
			['Inbox/Projects/Alpha', 2],
			['Trash', 0],
			['Trash/Old', 1],
			['Receipts', 0]
		]);
	});

	it('finds parents by name, whatever the delimiter or slashes in names', () => {
		expect(
			nested([
				{ path: 'INBOX', name: 'INBOX', depth: 0 },
				{ path: 'INBOX.Receipts', name: 'Receipts', depth: 1 },
				{ path: 'Inbox', name: 'Inbox', depth: 0 },
				{ path: 'Inbox/A/B', name: 'A/B', depth: 1 }
			])
		).toEqual([
			['INBOX', 0],
			['INBOX.Receipts', 1],
			['Inbox', 0],
			['Inbox/A/B', 1]
		]);
	});

	it('makes a folder whose parent is not listed a root', () => {
		expect(
			nested([
				{ path: 'INBOX', name: 'INBOX', depth: 0 },
				{ path: '[Gmail]/Spam', name: 'Spam', depth: 1 },
				{ path: '[Gmail]/Starred', name: 'Starred', depth: 1 }
			])
		).toEqual([
			['INBOX', 0],
			['[Gmail]/Spam', 0],
			['[Gmail]/Starred', 0]
		]);
	});
});

describe('renamedPath', () => {
	it('keeps the parent path and its delimiter', () => {
		expect(renamedPath({ path: 'INBOX.Projects.Alpha', name: 'Alpha', depth: 2 }, 'Beta')).toBe(
			'INBOX.Projects.Beta'
		);
		expect(renamedPath({ path: 'Receipts', name: 'Receipts', depth: 0 }, 'Bills')).toBe('Bills');
	});
});

describe('isWithin', () => {
	const entries = [
		{ path: 'Projects', name: 'Projects', depth: 0 },
		{ path: 'Projects/Alpha', name: 'Alpha', depth: 1 },
		{ path: 'Projects2', name: 'Projects2', depth: 0 },
		{ path: 'Projects2/Notes', name: 'Notes', depth: 1 }
	];

	it('includes the folder and its subfolders only', () => {
		const projects = entries[0];
		expect(isWithin('Projects', projects, entries)).toBe(true);
		expect(isWithin('Projects/Alpha', projects, entries)).toBe(true);
		expect(isWithin('Projects2', projects, entries)).toBe(false);
		expect(isWithin('Projects2/Notes', projects, entries)).toBe(false);
		expect(isWithin('inbox', projects, entries)).toBe(false);
	});
});
