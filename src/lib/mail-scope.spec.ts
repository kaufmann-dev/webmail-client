import { describe, expect, it } from 'vitest';
import {
	narrowedScope,
	scopeAccountIds,
	scopeFor,
	singleAccount,
	switchedFolder,
	toggledScope,
	viewedRole
} from './mail-scope';
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
		expect(switchedFolder('sent', 'b+unreachable', folders)).toBe('sent');
	});

	it('opens the inbox for custom folders and missing roles', () => {
		expect(switchedFolder(null, 'b', folders)).toBe('inbox');
		expect(switchedFolder(null, 'all', folders)).toBe('inbox');
		expect(switchedFolder('sent', 'b', folders)).toBe('inbox');
		expect(switchedFolder('sent', 'unreachable', folders)).toBe('inbox');
	});
});

const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('scopes', () => {
	it('tells single accounts from combined views', () => {
		expect(singleAccount('a')).toBe('a');
		expect(singleAccount('a+b')).toBeNull();
		expect(singleAccount('all')).toBeNull();
		expect(scopeAccountIds('all', accounts)).toEqual(['a', 'b', 'c']);
		expect(scopeAccountIds('c+a', accounts)).toEqual(['a', 'c']);
	});

	it('orders selections and folds every account into all', () => {
		expect(scopeFor(['c', 'a', 'c', 'missing'], accounts)).toBe('a+c');
		expect(scopeFor(['b'], accounts)).toBe('b');
		expect(scopeFor(['a', 'b', 'c'], accounts)).toBe('all');
		expect(scopeFor([], accounts)).toBe('all');
	});

	it('toggles accounts in and out of the view', () => {
		expect(toggledScope('all', 'b', accounts)).toBe('a+c');
		expect(toggledScope('a', 'c', accounts)).toBe('a+c');
		expect(toggledScope('a+c', 'b', accounts)).toBe('all');
		expect(toggledScope('a+c', 'a', accounts)).toBe('c');
		expect(toggledScope('a', 'a', accounts)).toBe('a');
	});

	it('finds the accounts left when a view narrows', () => {
		expect(narrowedScope('all', 'a+c', accounts)).toEqual(new Set(['a', 'c']));
		expect(narrowedScope('a+c', 'c', accounts)).toEqual(new Set(['c']));
		expect(narrowedScope('a', 'all', accounts)).toBeNull();
		expect(narrowedScope('a', 'b', accounts)).toBeNull();
		expect(narrowedScope('a+c', 'a+c', accounts)).toBeNull();
	});
});
