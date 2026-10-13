import { describe, expect, it } from 'vitest';
import { isWithin, renamedPath, visibleTree } from './folder-tree';

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
