import { describe, expect, it } from 'vitest';
import { parseAddressList } from './addresses';

describe('parseAddressList', () => {
	it('parses names, bare addresses, and quoted commas', () => {
		expect(parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.org')).toEqual([
			{ name: 'Doe, Jane', address: 'jane@example.com' },
			{ name: '', address: 'bob@example.org' }
		]);
		expect(parseAddressList(['a@b.co', 'C <c@d.co>'])).toHaveLength(2);
		expect(parseAddressList('  ')).toEqual([]);
	});

	it('rejects invalid entries', () => {
		expect(() => parseAddressList('not an address')).toThrow(/valid email/);
		expect(() => parseAddressList('a@b.co, broken@')).toThrow(/broken@/);
	});
});
