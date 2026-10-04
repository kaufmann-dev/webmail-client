import { describe, expect, it } from 'vitest';
import { switchedFolder, viewedRole } from './mail-scope';
import type { FolderEntry } from './move-targets';

const folders: Record<string, FolderEntry[]> = {
	a: [
		{ path: 'INBOX', name: 'INBOX', depth: 0, role: 'inbox' },
		{ path: 'Sent Items', name: 'Sent Items', depth: 0, role: 'sent' },
		{ path: 'Projects', name: 'Projects', depth: 0, role: null }
	],
	b: [{ path: 'INBOX', name: 'INBOX', depth: 0, role: 'inbox' }],
	unreachable: []
};

describe('viewedRole', () => {
	it('reads roles from role keys and folder paths', () => {
		expect(viewedRole('all', 'sent', folders)).toBe('sent');
		expect(viewedRole('a', 'Sent Items', folders)).toBe('sent');
		expect(viewedRole('a', 'Projects', folders)).toBeNull();
		expect(viewedRole('missing', 'Projects', folders)).toBeNull();
	});
});

describe('switchedFolder', () => {
	it('keeps the viewed role when the new scope has it', () => {
		expect(switchedFolder('sent', 'a', folders)).toBe('sent');
		expect(switchedFolder('sent', 'all', folders)).toBe('sent');
	});

	it('opens the inbox for custom folders and missing roles', () => {
		expect(switchedFolder(null, 'b', folders)).toBe('inbox');
		expect(switchedFolder(null, 'all', folders)).toBe('inbox');
		expect(switchedFolder('sent', 'b', folders)).toBe('inbox');
		expect(switchedFolder('sent', 'unreachable', folders)).toBe('inbox');
	});
});
