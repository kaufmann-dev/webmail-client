import { describe, expect, it } from 'vitest';
import { dateGroup, listDate } from './format';

// Tuesday, 13 October 2026, in local time.
const now = new Date(2026, 9, 13, 10);
const at = (...parts: [number, number, number, number?, number?]) =>
	new Date(...parts).toISOString();
const month = (iso: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat(undefined, options).format(new Date(iso));

describe('dateGroup', () => {
	it('names recent days and weeks', () => {
		expect(dateGroup(at(2026, 9, 13, 0, 5), now)).toBe('Today');
		expect(dateGroup(at(2026, 9, 14, 8), now)).toBe('Today');
		expect(dateGroup(at(2026, 9, 12, 23, 30), now)).toBe('Yesterday');
		expect(dateGroup(at(2026, 9, 11, 22), now)).toBe('Last week');
		expect(dateGroup(at(2026, 9, 5, 9), now)).toBe('Last week');
	});

	it('starts the week on Monday', () => {
		const thursday = new Date(2026, 9, 15, 10);
		expect(dateGroup(at(2026, 9, 12, 9), thursday)).toBe('This week');
		expect(dateGroup(at(2026, 9, 11, 23), thursday)).toBe('Last week');
		const monday = new Date(2026, 9, 12, 10);
		expect(dateGroup(at(2026, 9, 11, 9), monday)).toBe('Yesterday');
		expect(dateGroup(at(2026, 9, 10, 9), monday)).toBe('Last week');
	});

	it('falls back to the month, with the year before this one', () => {
		const october = at(2026, 9, 4, 9);
		expect(dateGroup(october, now)).toBe(month(october, { month: 'long' }));
		const december = at(2025, 11, 20, 9);
		expect(dateGroup(december, now)).toBe(month(december, { month: 'long', year: 'numeric' }));
	});
});

describe('listDate', () => {
	it('shows only the time today and yesterday', () => {
		const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
		const yesterday = at(2026, 9, 12, 18, 45);
		expect(listDate(yesterday, now)).toBe(time.format(new Date(yesterday)));
		const earlier = at(2026, 9, 11, 18, 45);
		expect(listDate(earlier, now)).toBe(
			new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(
				new Date(earlier)
			)
		);
	});
});
