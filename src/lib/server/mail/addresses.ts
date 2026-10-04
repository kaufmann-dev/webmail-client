import addressparser from 'nodemailer/lib/addressparser';
import type { Address } from '../../mail-types';
import { MailError } from './errors';

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** Parses `Name <a@example.com>, b@example.com` lists; rejects anything that is not an address. */
export function parseAddressList(input: string | string[]): Address[] {
	const text = Array.isArray(input) ? input.join(', ') : input;
	if (!text.trim()) return [];
	return addressparser(text, { flatten: true }).map((entry) => {
		if (!EMAIL.test(entry.address)) {
			throw new MailError(`Not a valid email address: ${entry.address || entry.name}`, 400);
		}
		return { name: entry.name, address: entry.address };
	});
}
