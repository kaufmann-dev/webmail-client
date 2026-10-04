import type { Address } from '../../mail-types';

/** The parts of an original message that a reply or forward is derived from. */
export interface OriginalMessage {
	messageId: string | null;
	references: string[];
	subject: string;
	from: Address | null;
	replyTo: Address[];
	to: Address[];
	cc: Address[];
	date: Date | null;
	text: string;
}

const PREFIX = /^\s*(?:re|aw|antw|sv|fwd?|wg|tr|rv)\s*(?:\[\d+\])?\s*:\s*/i;
const MAX_REFERENCES = 20;

/** Strips any stack of reply/forward prefixes (`Re:`, `AW:`, `Fwd:`, `WG:` …). */
export function baseSubject(subject: string): string {
	let value = subject.trim();
	while (PREFIX.test(value)) value = value.replace(PREFIX, '');
	return value;
}

export function replySubject(subject: string): string {
	return `Re: ${baseSubject(subject)}`.trimEnd();
}

export function forwardSubject(subject: string): string {
	return `Fwd: ${baseSubject(subject)}`.trimEnd();
}

/** True when a subject reads as a reply, which a new-conversation tool must not send. */
export function looksLikeReplySubject(subject: string): boolean {
	return /^\s*(?:re|aw|antw|sv)\s*(?:\[\d+\])?\s*:/i.test(subject);
}

/**
 * `References` for a reply (RFC 5322 §3.6.4): the original's references followed by its
 * Message-ID. Long chains keep the thread root and the most recent ancestors.
 */
export function replyReferences(original: Pick<OriginalMessage, 'messageId' | 'references'>) {
	const ids = [...original.references, ...(original.messageId ? [original.messageId] : [])];
	const unique = [...new Set(ids.filter(Boolean))];
	if (unique.length <= MAX_REFERENCES) return unique;
	return [unique[0], ...unique.slice(-(MAX_REFERENCES - 1))];
}

const normalize = (address: string) => address.trim().toLowerCase();

function dedupe(addresses: Address[], exclude: Set<string>): Address[] {
	const seen = new Set(exclude);
	const result: Address[] = [];
	for (const entry of addresses) {
		const key = normalize(entry.address);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

/**
 * Recipients of a reply. Replies go to Reply-To, falling back to From; reply-all copies the
 * original To and Cc. The replying account's own addresses are never included, and replying to a
 * message the account sent itself goes to that message's original recipients.
 */
export function replyRecipients(
	original: Pick<OriginalMessage, 'from' | 'replyTo' | 'to' | 'cc'>,
	ownAddresses: string[],
	replyAll: boolean
): { to: Address[]; cc: Address[] } {
	const own = new Set(ownAddresses.map(normalize));
	const sentByMe = original.from ? own.has(normalize(original.from.address)) : false;
	const primary = sentByMe
		? original.to
		: original.replyTo.length
			? original.replyTo
			: original.from
				? [original.from]
				: [];
	const to = dedupe(primary, own);
	if (!replyAll) return { to, cc: [] };
	const taken = new Set([...own, ...to.map((a) => normalize(a.address))]);
	const cc = dedupe(sentByMe ? original.cc : [...original.to, ...original.cc], taken);
	return { to: to.length ? to : cc.slice(0, 1), cc: to.length ? cc : cc.slice(1) };
}

export function formatAddress(address: Address): string {
	return address.name ? `${address.name} <${address.address}>` : address.address;
}

function formatDate(date: Date | null): string {
	return date ? date.toUTCString() : 'an unknown date';
}

/** Quoted original for the bottom of a reply. */
export function quoteOriginal(original: Pick<OriginalMessage, 'from' | 'date' | 'text'>): string {
	const who = original.from ? formatAddress(original.from) : 'someone';
	const body = original.text
		.replace(/\r\n/g, '\n')
		.trimEnd()
		.split('\n')
		.map((line) => (line.startsWith('>') ? `>${line}` : `> ${line}`))
		.join('\n');
	return `On ${formatDate(original.date)}, ${who} wrote:\n${body}`;
}

/** Header block and text of a forwarded message. */
export function forwardedBlock(original: OriginalMessage): string {
	const lines = [
		'---------- Forwarded message ---------',
		`From: ${original.from ? formatAddress(original.from) : ''}`,
		`Date: ${formatDate(original.date)}`,
		`Subject: ${original.subject}`,
		`To: ${original.to.map(formatAddress).join(', ')}`
	];
	if (original.cc.length) lines.push(`Cc: ${original.cc.map(formatAddress).join(', ')}`);
	return `${lines.join('\n')}\n\n${original.text.replace(/\r\n/g, '\n').trimEnd()}`;
}

/** Assembles the plain-text body: the user's text, the signature, then any quoted material. */
export function composeBody(text: string, signature: string | null, quoted?: string): string {
	const parts = [text.trimEnd()];
	if (signature?.trim()) parts.push(`-- \n${signature.trimEnd()}`);
	if (quoted) parts.push(quoted);
	return parts.filter((part, index) => index === 0 || part).join('\n\n');
}
