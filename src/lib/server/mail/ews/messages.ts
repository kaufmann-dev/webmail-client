import { simpleParser } from 'mailparser';
import type { Address, MessageDetail, MessageSummary } from '../../../mail-types';
import { bodyText, previewOfCollapsed } from '../body-text';
import { MailError, MessageGoneError } from '../errors';
import { findCalendarPart, isCalendarPart, parseInvitation } from '../invitations';
import type { AccountPage } from '../merge';
import type { EwsLocator } from '../message-ref';
import type { MessageFilters, ReadMessage } from '../messages';
import { sanitizeEmailHtml, textToHtml } from '../render';
import type { MailAccount } from '../types';
import { check, ewsCall, failed } from './client';
import { ewsFolders, folderIdOf } from './folders';
import {
	attachmentFileName,
	attachmentIdOf,
	attachmentsOf,
	dateOrNull,
	firstItem,
	inTransit,
	isExchangeAddress,
	itemId,
	itemsOf,
	mailboxes,
	MESSAGE_TYPES,
	partIdOf,
	summaryOf,
	timeCursors,
	timePosition,
	type EwsAttachment
} from './items';
import * as request from './requests';
import { attr, child, list, text, type XmlNode } from './xml';

/** Embedded images inlined as data URIs, at most this much per message. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/** X.500 addresses of internal senders resolved to SMTP, per account. */
const resolvedAddresses = new Map<string, Map<string, string | null>>();

export function forgetResolvedAddresses(accountId: string): void {
	resolvedAddresses.delete(accountId);
}

/** Name resolutions per batch, so a page of internal senders does not get throttled. */
const RESOLVE_BATCH = 5;

/**
 * Replaces X.500 addresses (routing type EX) with SMTP addresses where Exchange resolves them.
 * Only answers are remembered; a failed lookup is tried again next time.
 */
async function resolveAddresses(
	account: MailAccount,
	addresses: (Address | null)[]
): Promise<void> {
	const known = resolvedAddresses.get(account.id) ?? new Map<string, string | null>();
	resolvedAddresses.set(account.id, known);
	const wanted = addresses.filter((a): a is Address => !!a && isExchangeAddress(a.address));
	const pending = [...new Set(wanted.map((a) => a.address))].filter((dn) => !known.has(dn));
	for (let i = 0; i < pending.length; i += RESOLVE_BATCH) {
		await Promise.all(
			pending.slice(i, i + RESOLVE_BATCH).map(async (dn) => {
				try {
					const [message] = await ewsCall(account, request.resolveName(dn));
					if (failed(message)) {
						if (text(message.ResponseCode) === 'ErrorNameResolutionNoResults') known.set(dn, null);
						return;
					}
					const resolution = child(child(message, 'ResolutionSet'), 'Resolution');
					known.set(dn, text(child(resolution, 'Mailbox')?.EmailAddress) || null);
				} catch {
					// Not remembered: throttling and network errors pass.
				}
			})
		);
	}
	for (const address of wanted) address.address = known.get(address.address) ?? address.address;
}

function summaries(page: MessageSummary[]): (Address | null)[] {
	return page.flatMap((s) => [s.from, ...s.to]);
}

/**
 * One page of a folder, newest first. Pages run by received time (`timeCursors`), so moving or
 * flagging listed messages shifts nothing; text searches, which take no time restriction, page by
 * position (the number of messages already listed).
 */
export async function listPage(
	account: MailAccount,
	path: string,
	filters: MessageFilters,
	cursor: number | undefined,
	limit: number,
	options: { threads?: boolean } = {}
): Promise<AccountPage> {
	const byTime = request.queryString(filters) === null;
	const position = byTime && cursor !== undefined ? timePosition(cursor) : null;
	const offset = position ? position.skip : (cursor ?? 0);
	const pageFilters =
		position && !(filters.before && filters.before <= position.before)
			? { ...filters, before: position.before }
			: filters;
	const folder = await folderIdOf(account, path);
	const [found] = await ewsCall(account, request.findItems(folder, pageFilters, offset, limit));
	const root = child(check(found), 'RootFolder');
	// Items of different types arrive grouped by type, so the server's order is restored by date.
	const fetched = itemsOf(child(root, 'Items'))
		.map(({ node }) => ({
			id: itemId(node),
			received: Date.parse(text(node.DateTimeReceived)) || 0
		}))
		.sort((a, b) => b.received - a.received);
	const exhausted = attr(root, 'IncludesLastItemInRange') !== 'false';
	if (!fetched.length) return { accountId: account.id, items: [], exhausted: true, last: null };
	const cursors = byTime
		? timeCursors(
				fetched.map((entry) => entry.received),
				cursor
			)
		: fetched.map((_, index) => offset + index + 1);
	const fields = options.threads ? request.THREAD_FIELDS : request.SUMMARY_FIELDS;
	const messages = await ewsCall(
		account,
		request.getItems(
			fetched.map((entry) => entry.id),
			fields
		)
	);
	const items = messages.flatMap((message, index) => {
		const item = failed(message) ? null : firstItem(message);
		return item && !inTransit(item.node)
			? [summaryOf(account.id, path, item.node, cursors[index])]
			: [];
	});
	await resolveAddresses(account, summaries(items));
	return { accountId: account.id, items, exhausted, last: cursors[cursors.length - 1] };
}

interface AttachmentNode {
	node: XmlNode;
	/** An attached item (an email or meeting) rather than a file. */
	item: boolean;
}

async function getAttachmentNodes(account: MailAccount, ids: string[]): Promise<AttachmentNode[]> {
	if (!ids.length) return [];
	const messages = await ewsCall(account, request.getAttachments(ids));
	return messages.map((message) => {
		const attachments = child(check(message), 'Attachments');
		const file = child(attachments, 'FileAttachment');
		const node = file ?? child(attachments, 'ItemAttachment');
		if (!node) throw new MailError('Attachment not found.', 404);
		return { node, item: !file };
	});
}

/** The content of a file attachment, or the MIME source of an attached item. */
function attachmentContent({ node, item }: AttachmentNode): Buffer {
	if (!item) return Buffer.from(text(node.Content), 'base64');
	const attached = Object.values(node).find(
		(value): value is XmlNode =>
			typeof value === 'object' && value !== null && 'MimeContent' in value
	);
	return Buffer.from(text(attached?.MimeContent), 'base64');
}

/** Replaces `cid:` references to embedded images with data URIs. */
async function embedImages(
	account: MailAccount,
	html: string,
	attachments: EwsAttachment[]
): Promise<{ html: string; embedded: Set<string> }> {
	const embedded = new Set<string>();
	let budget = MAX_INLINE_BYTES;
	const wanted = attachments.filter((a) => {
		if (!a.contentId || a.item || !html.includes(`cid:${a.contentId}`) || a.size > budget) {
			return false;
		}
		budget -= a.size;
		return true;
	});
	const nodes = await getAttachmentNodes(
		account,
		wanted.map((a) => a.id)
	).catch(() => []);
	nodes.forEach((node, index) => {
		const attachment = wanted[index];
		const content = attachmentContent(node).toString('base64');
		const uri = `data:${attachment.contentType};base64,${content}`;
		html = html.split(`cid:${attachment.contentId}`).join(uri);
		embedded.add(attachment.id);
	});
	return { html, embedded };
}

/** The iCalendar text of a message, from its MIME form. */
async function meetingCalendar(account: MailAccount, id: string): Promise<string | null> {
	const [message] = await ewsCall(account, request.getItems([id], [], { mime: true }));
	const item = firstItem(check(message));
	const mime = text(item?.node.MimeContent);
	if (!mime) return null;
	const parsed = await simpleParser(Buffer.from(mime, 'base64'));
	return findCalendarPart(parsed.attachments);
}

export async function readMessage(account: MailAccount, locator: EwsLocator): Promise<ReadMessage> {
	const [message] = await ewsCall(
		account,
		request.getItems([locator.itemId], request.DETAIL_FIELDS, { body: true })
	);
	const item = firstItem(check(message));
	if (!item) throw new MessageGoneError();
	const { node } = item;
	const summary = summaryOf(account.id, locator.path, node, 0);
	const attachments = attachmentsOf(node);
	const body = text(node.Body);
	// The text comes from the HTML body (Exchange's own TextBody leaves entities and `[cid:…]`).
	const plain = bodyText({
		html: body || null,
		text: '',
		subject: summary.subject,
		images: new Map(
			attachments.flatMap((a) => (a.contentId && a.name ? [[a.contentId, a.name] as const] : []))
		)
	});
	const cc = mailboxes(child(node, 'CcRecipients'));
	const bcc = mailboxes(child(node, 'BccRecipients'));
	const replyTo = mailboxes(child(node, 'ReplyTo'));
	// The follow-up requests depend only on the item, so they run together.
	const [{ html, embedded }, calendar] = await Promise.all([
		body ? embedImages(account, body, attachments) : { html: '', embedded: new Set<string>() },
		// Meeting messages, and messages saved with a calendar part (the user's meeting drafts, which
		// Exchange may keep as ordinary messages with the part as an attachment).
		text(node.ItemClass).startsWith('IPM.Schedule.Meeting') || attachments.some(isCalendarPart)
			? meetingCalendar(account, locator.itemId)
			: null,
		resolveAddresses(account, [summary.from, ...summary.to, ...cc, ...bcc, ...replyTo])
	]);
	const sanitized = html ? sanitizeEmailHtml(html) : null;
	const detail: MessageDetail = {
		...summary,
		cc,
		bcc,
		replyTo,
		inReplyTo: text(node.InReplyTo) || null,
		references: text(node.References).split(/\s+/).filter(Boolean),
		text: plain.text,
		html: sanitized?.html ?? textToHtml(plain.text),
		hasRemoteImages: sanitized?.hasRemoteImages ?? false,
		attachments: attachments
			.filter((a) => !embedded.has(a.id))
			.map((a) => ({
				partId: partIdOf(a.id),
				filename: attachmentFileName(a),
				contentType: a.contentType,
				size: a.size
			})),
		invitation: calendar ? parseInvitation(calendar, account.email) : null
	};
	return {
		detail,
		newText: plain.newText,
		sentAt: dateOrNull(text(node.DateTimeSent)),
		calendar
	};
}

/** Downloads attachments by part ID, in the given order. */
export async function getAttachments(
	account: MailAccount,
	partIds: string[]
): Promise<{ filename: string; contentType: string; content: Buffer }[]> {
	const nodes = await getAttachmentNodes(account, partIds.map(attachmentIdOf));
	return nodes.map((attachment) => ({
		filename: attachmentFileName({ name: text(attachment.node.Name), item: attachment.item }),
		contentType: attachment.item
			? 'message/rfc822'
			: text(attachment.node.ContentType) || 'application/octet-stream',
		content: attachmentContent(attachment)
	}));
}

/** When items were received, in the given order; null for items that are gone. */
export async function receivedDates(
	account: MailAccount,
	ids: string[]
): Promise<(string | null)[]> {
	if (!ids.length) return [];
	const messages = await ewsCall(account, request.getItems(ids, ['item:DateTimeReceived']));
	return messages.map((message) => {
		const item = failed(message) ? null : firstItem(message);
		return dateOrNull(text(item?.node.DateTimeReceived))?.toISOString() ?? null;
	});
}

/** The element names of items, needed to update them; null for items that are gone. */
async function itemTypes(account: MailAccount, ids: string[]): Promise<(string | null)[]> {
	const messages = await ewsCall(account, request.getItems(ids, []));
	return messages.map((message) => (failed(message) ? null : (firstItem(message)?.type ?? null)));
}

async function updateItems(
	account: MailAccount,
	ids: string[],
	fields: (type: string) => string[]
): Promise<void> {
	const types = await itemTypes(account, ids);
	const updates = ids.flatMap((id, index) => {
		const type = types[index];
		const changes = type ? fields(type) : [];
		return type && changes.length ? [{ id, type, fields: changes }] : [];
	});
	if (!updates.length) return;
	const messages = await ewsCall(account, request.updateItems(updates));
	for (const message of messages) check(message);
}

export function setFlags(
	account: MailAccount,
	ids: string[],
	flags: { seen?: boolean; flagged?: boolean }
): Promise<void> {
	return updateItems(account, ids, (type) => [
		...(flags.seen !== undefined && MESSAGE_TYPES.has(type) ? [request.setIsRead(flags.seen)] : []),
		...(flags.flagged !== undefined ? [request.setFlag(flags.flagged)] : [])
	]);
}

/** Marks messages as replied to (PidTagLastVerbExecuted and PidTagIconIndex), as Outlook does. */
export function markAnswered(account: MailAccount, ids: string[]): Promise<void> {
	return updateItems(account, ids, () => [
		request.setIntegerProperty('0x1081', 102),
		request.setIntegerProperty('0x1080', 261)
	]);
}

/** Moves items and returns their new IDs (Exchange IDs change with the folder), in order. */
export async function moveItems(
	account: MailAccount,
	ids: string[],
	path: string
): Promise<(string | null)[]> {
	const messages = await ewsCall(account, request.moveItems(ids, await folderIdOf(account, path)));
	return messages.map((message) => {
		// Gone already, like `deleteItems`; the others still move.
		if (text(message.ResponseCode) === 'ErrorItemNotFound') return null;
		const item = firstItem(check(message));
		return item ? itemId(item.node) || null : null;
	});
}

/** One-line previews without quotes, in the given order; null for items that are gone. */
export async function previews(
	account: MailAccount,
	items: { itemId: string; subject: string }[]
): Promise<(string | null)[]> {
	const messages = await ewsCall(
		account,
		request.getItems(
			items.map((i) => i.itemId),
			request.PREVIEW_FIELDS
		)
	);
	return messages.map((message, index) => {
		const item = failed(message) ? null : firstItem(message);
		return item ? previewOfCollapsed(text(item.node.Preview), items[index].subject) : null;
	});
}

/** The item with a Message-ID header in a folder, or null. */
export async function findByMessageId(
	account: MailAccount,
	path: string,
	messageId: string
): Promise<string | null> {
	const folder = await folderIdOf(account, path);
	const [found] = await ewsCall(account, request.findByMessageId(folder, messageId));
	const [item] = itemsOf(child(child(check(found), 'RootFolder'), 'Items'));
	return item ? itemId(item.node) || null : null;
}

export async function deleteItems(account: MailAccount, ids: string[]): Promise<void> {
	const messages = await ewsCall(account, request.deleteItems(ids));
	for (const message of messages) {
		if (text(message.ResponseCode) !== 'ErrorItemNotFound') check(message);
	}
}

/** Conversations per GetConversationItems request. */
const CONVERSATIONS_PER_REQUEST = 25;

/** The messages of conversations, oldest first, in any folder but Deleted Items and Junk. */
export async function conversations(
	account: MailAccount,
	conversationIds: string[]
): Promise<MessageSummary[]> {
	if (!conversationIds.length) return [];
	const { pathById } = await ewsFolders(account);
	const found: MessageSummary[] = [];
	for (let i = 0; i < conversationIds.length; i += CONVERSATIONS_PER_REQUEST) {
		const chunk = conversationIds.slice(i, i + CONVERSATIONS_PER_REQUEST);
		for (const response of await ewsCall(account, request.conversationItems(chunk))) {
			if (failed(response)) continue;
			const nodes = list(
				child(child(response, 'Conversation'), 'ConversationNodes')?.ConversationNode
			);
			for (const node of nodes) {
				for (const { node: item } of itemsOf(child(node, 'Items'))) {
					const path = pathById.get(attr(child(item, 'ParentFolderId'), 'Id'));
					if (path && !inTransit(item)) found.push(summaryOf(account.id, path, item, 0));
				}
			}
		}
	}
	await resolveAddresses(account, summaries(found));
	return found.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/** The conversation around a message, oldest first, from Exchange's own conversation index. */
export async function getThread(
	account: MailAccount,
	locator: EwsLocator
): Promise<MessageSummary[]> {
	const [message] = await ewsCall(
		account,
		request.getItems([locator.itemId], ['item:ConversationId'])
	);
	const conversationId = attr(child(firstItem(check(message))?.node, 'ConversationId'), 'Id');
	return conversationId ? conversations(account, [conversationId]) : [];
}
