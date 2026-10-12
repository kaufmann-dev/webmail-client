import { describe, expect, it } from 'vitest';
import { grantsFromForm } from './connected-apps';

describe('grantsFromForm', () => {
	it('keeps valid levels and drops "none" and unrelated fields', () => {
		const form = new FormData();
		form.set('access:a', 'read');
		form.set('attachments:a', 'on');
		form.set('access:b', 'none');
		form.set('access:c', 'send');
		form.set('attachments:c', 'on');
		form.set('access:d', 'admin');
		form.set('clientId', 'x');
		expect(grantsFromForm(form)).toEqual([
			{ accountId: 'a', level: 'read', maxAgeDays: null, allowAttachments: true },
			{ accountId: 'c', level: 'send', maxAgeDays: null, allowAttachments: true }
		]);
	});

	it('reads the time window and treats unknown values as any age', () => {
		const form = new FormData();
		for (const [id, days] of [
			['a', '30'],
			['b', ''],
			['c', '5'],
			['d', 'x']
		]) {
			form.set(`access:${id}`, 'read');
			form.set(`maxAge:${id}`, days);
		}
		expect(grantsFromForm(form).map((g) => g.maxAgeDays)).toEqual([30, null, null, null]);
	});

	it('withholds attachments when the checkbox is unchecked', () => {
		const form = new FormData();
		form.set('access:a', 'organize');
		form.set('maxAge:a', '7');
		expect(grantsFromForm(form)).toEqual([
			{ accountId: 'a', level: 'organize', maxAgeDays: 7, allowAttachments: false }
		]);
	});
});
