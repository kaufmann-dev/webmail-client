import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM; the output is `iv.tag.ciphertext`, each part base64url. */
export function encryptSecret(plaintext: string, keyBase64: string): string {
	const key = parseKey(keyBase64);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(sealed: string, keyBase64: string): string {
	const [iv, tag, ciphertext] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
	if (!iv || !tag || !ciphertext) throw new Error('Malformed encrypted secret');
	const decipher = createDecipheriv('aes-256-gcm', parseKey(keyBase64), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function parseKey(keyBase64: string): Buffer {
	const key = Buffer.from(keyBase64, 'base64');
	if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded');
	return key;
}
