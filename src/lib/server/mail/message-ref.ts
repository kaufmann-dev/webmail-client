/**
 * Opaque, URL-safe reference to one message. Over IMAP: account, mailbox path, UIDVALIDITY, and
 * UID; UIDs are only meaningful together with the mailbox's UIDVALIDITY, so a stale reference is
 * detected instead of silently pointing at a different message. On Exchange: account, folder
 * path, and the EWS item ID, which changes when the item moves.
 */
export type MessageLocator = ImapLocator | EwsLocator;

export interface ImapLocator {
	kind: 'imap';
	accountId: string;
	path: string;
	uidValidity: string;
	uid: number;
}

export interface EwsLocator {
	kind: 'ews';
	accountId: string;
	path: string;
	itemId: string;
}

export class InvalidMessageRefError extends Error {
	constructor(message = 'Invalid message reference.') {
		super(message);
		this.name = 'InvalidMessageRefError';
	}
}

export function encodeMessageRef(locator: MessageLocator): string {
	const payload =
		locator.kind === 'imap'
			? [locator.accountId, locator.path, locator.uidValidity, locator.uid]
			: [locator.accountId, locator.path, locator.itemId];
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeMessageRef(ref: string): MessageLocator {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
	} catch {
		throw new InvalidMessageRefError();
	}
	if (!Array.isArray(value) || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
		throw new InvalidMessageRefError();
	}
	const [accountId, path] = value as [string, string];
	if (value.length === 3 && typeof value[2] === 'string' && value[2]) {
		return { kind: 'ews', accountId, path, itemId: value[2] };
	}
	if (
		value.length === 4 &&
		typeof value[2] === 'string' &&
		/^\d+$/.test(value[2]) &&
		Number.isSafeInteger(value[3]) &&
		value[3] >= 1
	) {
		return { kind: 'imap', accountId, path, uidValidity: value[2], uid: value[3] };
	}
	throw new InvalidMessageRefError();
}

/** The locator of an IMAP account's message; a ref of the other kind is invalid for it. */
export function imapLocator(locator: MessageLocator): ImapLocator {
	if (locator.kind !== 'imap') throw new InvalidMessageRefError();
	return locator;
}

/** The locator of an Exchange account's message; a ref of the other kind is invalid for it. */
export function ewsLocator(locator: MessageLocator): EwsLocator {
	if (locator.kind !== 'ews') throw new InvalidMessageRefError();
	return locator;
}

/**
 * The ref of a message after its folder, or a folder above it, was renamed from `from` to `to`;
 * null for a message elsewhere. `delimiter` separates subfolder paths (null: no hierarchy).
 */
export function renamedFolderRef(
	ref: string,
	from: string,
	to: string,
	delimiter: string | null
): string | null {
	const locator = decodeMessageRef(ref);
	const inside =
		locator.path === from || (delimiter !== null && locator.path.startsWith(from + delimiter));
	return inside
		? encodeMessageRef({ ...locator, path: to + locator.path.slice(from.length) })
		: null;
}
