import { describe, expect, it } from 'vitest';
import {
	decodeMessageRef,
	encodeMessageRef,
	ewsLocator,
	imapLocator,
	InvalidMessageRefError,
	type MessageLocator
} from './message-ref';

describe('message refs', () => {
	it('round-trips IMAP refs with unicode paths', () => {
		const locator: MessageLocator = {
			kind: 'imap',
			accountId: 'a1',
			path: 'Archiv/Prüfungen',
			uidValidity: '1700000000',
			uid: 42
		};
		const ref = encodeMessageRef(locator);
		expect(ref).toMatch(/^[\w-]+$/);
		expect(decodeMessageRef(ref)).toEqual(locator);
	});

	it('round-trips Exchange refs', () => {
		const locator: MessageLocator = {
			kind: 'ews',
			accountId: 'a2',
			path: 'Posteingang/Schule',
			itemId: 'AAMkADk0ZjQ+/=='
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
			Buffer.from('["a","INBOX","1",1.5]').toString('base64url'),
			Buffer.from('["a","INBOX",""]').toString('base64url'),
			Buffer.from('["a","INBOX",5]').toString('base64url')
		];
		for (const ref of bad) expect(() => decodeMessageRef(ref)).toThrow(InvalidMessageRefError);
	});

	it('rejects a ref of the wrong kind for the account', () => {
		const imap = decodeMessageRef(Buffer.from('["a","INBOX","1",7]').toString('base64url'));
		expect(imapLocator(imap).uid).toBe(7);
		expect(() => ewsLocator(imap)).toThrow(InvalidMessageRefError);
	});
});
