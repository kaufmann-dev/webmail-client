import { describe, expect, it } from 'vitest';
import { grantsFromForm } from './connected-apps';

describe('grantsFromForm', () => {
	it('keeps valid levels and drops "none" and unrelated fields', () => {
		const form = new FormData();
		form.set('access:a', 'read');
		form.set('access:b', 'none');
		form.set('access:c', 'send');
		form.set('access:d', 'admin');
		form.set('clientId', 'x');
		expect(grantsFromForm(form)).toEqual([
			{ accountId: 'a', level: 'read' },
			{ accountId: 'c', level: 'send' }
		]);
	});
});
