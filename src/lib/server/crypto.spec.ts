import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto';

const key = randomBytes(32).toString('base64');

describe('encryptSecret', () => {
	it('round-trips and uses a fresh IV each time', () => {
		const a = encryptSecret('app password', key);
		expect(decryptSecret(a, key)).toBe('app password');
		expect(encryptSecret('app password', key)).not.toBe(a);
	});

	it('rejects a wrong key, tampering, and short keys', () => {
		const sealed = encryptSecret('secret', key);
		expect(() => decryptSecret(sealed, randomBytes(32).toString('base64'))).toThrow();
		const [iv, tag, data] = sealed.split('.');
		const flipped = Buffer.from(data, 'base64url');
		flipped[0] ^= 1;
		expect(() => decryptSecret([iv, tag, flipped.toString('base64url')].join('.'), key)).toThrow();
		expect(() => encryptSecret('x', randomBytes(16).toString('base64'))).toThrow();
	});
});
