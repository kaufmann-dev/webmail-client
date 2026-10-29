import type { Address, MessageSummary } from '../../../mail-types';
import { encodeMessageRef } from '../message-ref';
import { attr, child, list, text, type XmlNode } from './xml';

/** Mapping EWS item elements to the mail layer's shapes. */

export interface EwsItem {
	/** The element name: `Message`, `MeetingRequest`, `MeetingCancellation`, … */
	type: string;
	node: XmlNode;
}

/** Item types that carry `IsRead`: `PostItem` and those deriving from EWS `MessageType`. */
export const MESSAGE_TYPES = new Set([
	'Message',
	'PostItem',
	'MeetingMessage',
	'MeetingRequest',
	'MeetingResponse',
	'MeetingCancellation'
]);

/** All items of an `Items` element, whatever their type. Document order across types is lost. */
export function itemsOf(items: XmlNode | undefined): EwsItem[] {
	return Object.entries(items ?? {}).flatMap(([type, value]) =>
		list(value).map((node) => ({ type, node }))
	);
}

/** The single item of a GetItem response message. */
export function firstItem(message: XmlNode): EwsItem | null {
	return itemsOf(child(message, 'Items'))[0] ?? null;
}

export function itemId(node: XmlNode): string {
	return attr(child(node, 'ItemId'), 'Id');
}

function isoDate(value: string): string {
	const date = value ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

export function dateOrNull(value: string): Date | null {
	const date = value ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date : null;
}

function mailbox(node: XmlNode | undefined): Address | null {
	const address = text(node?.EmailAddress);
	return address ? { name: text(node?.Name), address } : null;
}

/** The mailboxes of a recipient list such as `ToRecipients`. */
export function mailboxes(container: XmlNode | undefined): Address[] {
	return list(container?.Mailbox)
		.map(mailbox)
		.filter((a): a is Address => a !== null);
}

/** An X.500 address of an internal sender (routing type EX), which needs resolving to SMTP. */
export function isExchangeAddress(address: string): boolean {
	return address.startsWith('/');
}

/** How long Exchange may take to send a submitted item before it counts as stuck. */
const STUCK_MS = 15 * 60_000;

/**
 * An outgoing item Exchange has submitted but not sent yet, such as a meeting's invitation in
 * Drafts. One still there 15 minutes after it was submitted is stuck: it shows again, so it can be
 * deleted.
 */
export function inTransit(node: XmlNode, now = Date.now()): boolean {
	if (text(node.IsSubmitted) !== 'true' || text(node.IsDraft) !== 'true') return false;
	const submitted = Date.parse(text(node.LastModifiedTime));
	return Number.isNaN(submitted) || now - submitted < STUCK_MS;
}

/**
 * Exchange lists page by received time: a message's cursor is `second * TIES + n`, the nth message
 * listed in that second of its `DateTimeReceived`, so the next page skips the ties already listed.
 */
const TIES = 1_000_000;

/** Where the page after `cursor` starts: messages received before the end of its second, past its ties. */
export function timePosition(cursor: number): { before: Date; skip: number } {
	return { before: new Date((Math.floor(cursor / TIES) + 1) * 1000), skip: cursor % TIES };
}

/** The cursors of messages received at these times (ms, newest first) on the page after `cursor`. */
export function timeCursors(received: number[], cursor: number | undefined): number[] {
	let second = cursor === undefined ? null : Math.floor(cursor / TIES);
	let n = cursor === undefined ? 0 : cursor % TIES;
	return received.map((time) => {
		const current = Math.floor(time / 1000);
		n = current === second ? n + 1 : 1;
		second = current;
		return current * TIES + n;
	});
}

export function summaryOf(
	accountId: string,
	path: string,
	node: XmlNode,
	cursor: number
): MessageSummary {
	return {
		ref: encodeMessageRef({ kind: 'ews', accountId, path, itemId: itemId(node) }),
		accountId,
		cursor,
		from: mailbox(child(child(node, 'From'), 'Mailbox')),
		to: mailboxes(child(node, 'ToRecipients')),
		subject: text(node.Subject),
		date: isoDate(text(node.DateTimeReceived)),
		unread: text(node.IsRead) === 'false',
		starred: text(child(node, 'Flag')?.FlagStatus) === 'Flagged',
		// A submitted item is Exchange's to send; editing or sending it again would send it twice.
		draft: text(node.IsDraft) === 'true' && text(node.IsSubmitted) !== 'true',
		hasAttachments: text(node.HasAttachments) === 'true',
		messageId: text(node.InternetMessageId) || null,
		...('ConversationId' in node
			? {
					thread: {
						id: attr(child(node, 'ConversationId'), 'Id') || null,
						inReplyTo: null,
						references: []
					}
				}
			: {})
	};
}

export interface EwsAttachment {
	id: string;
	/** An attached item (an email or meeting) rather than a file. */
	item: boolean;
	name: string;
	contentType: string;
	size: number;
	inline: boolean;
	contentId: string | null;
}

export function attachmentsOf(node: XmlNode): EwsAttachment[] {
	const container = child(node, 'Attachments');
	return [
		...list(container?.FileAttachment).map((a) => ({ a, item: false })),
		...list(container?.ItemAttachment).map((a) => ({ a, item: true }))
	].map(({ a, item }) => ({
		id: attr(child(a, 'AttachmentId'), 'Id'),
		item,
		name: text(a.Name),
		contentType: item ? 'message/rfc822' : text(a.ContentType) || 'application/octet-stream',
		size: Number(text(a.Size)) || 0,
		inline: text(a.IsInline) === 'true',
		contentId: text(a.ContentId).replace(/^<|>$/g, '') || null
	}));
}

/** Attachment IDs are opaque base64 with `/` and `+`; part IDs travel in URLs. */
export function partIdOf(attachmentId: string): string {
	return Buffer.from(attachmentId, 'utf8').toString('base64url');
}

export function attachmentIdOf(partId: string): string {
	return Buffer.from(partId, 'base64url').toString('utf8');
}

export function attachmentFileName(attachment: Pick<EwsAttachment, 'name' | 'item'>): string {
	const name = attachment.name || 'attachment';
	return attachment.item && !/\.eml$/i.test(name) ? `${name}.eml` : name;
}
