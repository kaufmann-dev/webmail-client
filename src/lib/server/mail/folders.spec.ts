import { describe, expect, it } from 'vitest';
import { isHiddenFolder } from './folders';

describe('isHiddenFolder', () => {
	it("hides Gmail's label views, whether imapflow reports them as special use or not", () => {
		expect(isHiddenFolder({ flags: new Set(['\\HasNoChildren']), specialUse: '\\Flagged' })).toBe(
			true
		);
		expect(isHiddenFolder({ flags: new Set(['\\HasNoChildren', '\\Important']) })).toBe(true);
		expect(isHiddenFolder({ flags: new Set(['\\HasNoChildren']), specialUse: '\\All' })).toBe(true);
	});

	it('keeps ordinary folders', () => {
		expect(isHiddenFolder({ flags: new Set(['\\HasNoChildren']) })).toBe(false);
	});
});
