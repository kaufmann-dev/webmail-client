import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
	it('keeps same-origin paths', () => {
		expect(safeReturnTo('/mail/all/inbox?m=abc')).toBe('/mail/all/inbox?m=abc');
	});

	it('rejects external, protocol-relative, and auth URLs', () => {
		for (const value of [
			'https://evil.test',
			'//evil.test',
			'/\\evil.test',
			'/login',
			'/api/auth/x',
			'',
			null
		]) {
			expect(safeReturnTo(value)).toBe('/');
		}
	});
});
