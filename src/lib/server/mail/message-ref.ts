/**
 * Opaque, URL-safe reference to one message: account, mailbox path, UIDVALIDITY, and UID.
 * UIDs are only meaningful together with the mailbox's UIDVALIDITY, so a stale reference is
 * detected instead of silently pointing at a different message.
 */
export interface MessageLocator {
	accountId: string;
	path: string;
	uidValidity: string;
	uid: number;
}

export class InvalidMessageRefError extends Error {
	constructor(message = 'Invalid message reference.') {
		super(message);
		this.name = 'InvalidMessageRefError';
	}
}

export function encodeMessageRef(locator: MessageLocator): string {
	const payload = JSON.stringify([
		locator.accountId,
		locator.path,
		locator.uidValidity,
		locator.uid
	]);
	return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeMessageRef(ref: string): MessageLocator {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
	} catch {
		throw new InvalidMessageRefError();
	}
	if (
		!Array.isArray(value) ||
		value.length !== 4 ||
		typeof value[0] !== 'string' ||
		typeof value[1] !== 'string' ||
		typeof value[2] !== 'string' ||
		!/^\d+$/.test(value[2]) ||
		!Number.isSafeInteger(value[3]) ||
		value[3] < 1
	) {
		throw new InvalidMessageRefError();
	}
	return { accountId: value[0], path: value[1], uidValidity: value[2], uid: value[3] };
}
