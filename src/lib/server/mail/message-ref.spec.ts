import { describe, expect, it } from 'vitest';
import { decodeMessageRef, encodeMessageRef, InvalidMessageRefError } from './message-ref';

describe('message refs', () => {
	it('round-trips unicode paths', () => {
		const locator = {
			accountId: 'a1',
			path: 'Archiv/Prüfungen',
			uidValidity: '1700000000',
			uid: 42
		};
		const ref = encodeMessageRef(locator);
		expect(ref).toMatch(/^[\w-]+$/);
		expect(decodeMessageRef(ref)).toEqual(locator);
	});

	it('rejects malformed or tampered refs', () => {
		const bad = [
			'not-base64-json',
			Buffer.from('{"a":1}').toString('base64url'),
			Buffer.from('["a","INBOX","x",1]').toString('base64url'),
			Buffer.from('["a","INBOX","1",0]').toString('base64url'),
			Buffer.from('["a","INBOX","1",1.5]').toString('base64url')
		];
		for (const ref of bad) expect(() => decodeMessageRef(ref)).toThrow(InvalidMessageRefError);
	});
});
