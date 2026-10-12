import type {
	FetchMessageObject,
	MailboxObject,
	MessageAddressObject,
	MessageStructureObject,
	SearchObject
} from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type {
	AccountError,
	Address,
	ListFilter,
	MessageDetail,
	MessagePage,
	MessageSummary
} from '../../mail-types';
import { getAccount } from './accounts';
import { errorMessage, MailError } from './errors';
import { ensureArchiveFolder, requireFolder, resolveFolder } from './folders';
import { withMailbox } from './imap';
import { findCalendarPart, isCalendarPart, parseInvitation } from './invitations';
import { decodeCursor, encodeCursor, mergePages, type AccountPage } from './merge';
import { decodeMessageRef, encodeMessageRef, type MessageLocator } from './message-ref';
import { sanitizeEmailHtml, textToHtml } from './render';
import { assembleSource, planMessage, type StructurePart } from './structure';
import type { MailAccount } from './types';

export const DEFAULT_PAGE_SIZE = 50;

export interface MessageFilters {
	filter?: ListFilter;
	query?: string;
	from?: string;
	to?: string;
	subject?: string;
	since?: Date;
	before?: Date;
	unread?: boolean;
	starred?: boolean;
}

const SUMMARY_FETCH = {
	uid: true,
	flags: true,
	envelope: true,
	internalDate: true,
	bodyStructure: true
} as const;

function address(entry: MessageAddressObject | undefined): Address | null {
	return entry?.address ? { name: entry.name ?? '', address: entry.address } : null;
}

function addresses(list: MessageAddressObject[] | undefined): Address[] {
	return (list ?? []).map(address).filter((a): a is Address => a !== null);
}

function hasAttachment(node: MessageStructureObject | undefined): boolean {
	if (!node) return false;
	if (node.childNodes?.length) return node.childNodes.some(hasAttachment);
	if (node.disposition === 'attachment') return true;
	return node.disposition !== 'inline' && Boolean(node.parameters?.name);
}

function isoDate(value: Date | string | undefined): string {
	const date = value ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function toSummary(
	account: MailAccount,
	path: string,
	mailbox: MailboxObject,
	message: FetchMessageObject
): MessageSummary {
	const envelope = message.envelope ?? {};
	const flags = message.flags ?? new Set<string>();
	return {
		ref: encodeMessageRef({
			accountId: account.id,
			path,
			uidValidity: String(mailbox.uidValidity),
			uid: message.uid
		}),
		accountId: account.id,
		uid: message.uid,
		from: address(envelope.from?.[0]),
		to: addresses(envelope.to),
		subject: envelope.subject ?? '',
		date: isoDate(message.internalDate ?? envelope.date),
		unread: !flags.has('\\Seen'),
		starred: flags.has('\\Flagged'),
		draft: flags.has('\\Draft'),
		hasAttachments: hasAttachment(message.bodyStructure),
		messageId: envelope.messageId ?? null
	};
}

function buildSearch(account: MailAccount, filters: MessageFilters): SearchObject {
	const search: SearchObject = {};
	if (filters.filter === 'unread') search.seen = false;
	if (filters.filter === 'starred') search.flagged = true;
	if (filters.unread !== undefined) search.seen = !filters.unread;
	if (filters.starred !== undefined) search.flagged = filters.starred;
	if (filters.from) search.from = filters.from;
	if (filters.to) search.to = filters.to;
	if (filters.subject) search.subject = filters.subject;
	if (filters.since) search.since = filters.since;
	if (filters.before) search.before = filters.before;
	const query = filters.query?.trim();
	// Gmail understands its own search syntax (from:, has:attachment, …) through X-GM-RAW.
	if (query) {
		if (account.provider === 'gmail') search.gmraw = query;
		else search.text = query;
	}
	return search;
}

async function fetchAccountPage(
	account: MailAccount,
	path: string,
	search: SearchObject,
	beforeUid: number | undefined,
	limit: number
): Promise<AccountPage> {
	return withMailbox(account, path, async (client, mailbox) => {
		if (beforeUid !== undefined && beforeUid <= 1) {
			return { accountId: account.id, items: [], exhausted: true };
		}
		const query: SearchObject = { ...search };
		if (beforeUid !== undefined) query.uid = `1:${beforeUid - 1}`;
		if (Object.keys(query).length === 0) query.all = true;
		const found = ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
		const picked = found.slice(-limit);
		if (!picked.length) return { accountId: account.id, items: [], exhausted: true };
		const fetched = await client.fetchAll(picked, SUMMARY_FETCH, { uid: true });
		return {
			accountId: account.id,
			items: fetched.map((m) => toSummary(account, path, mailbox, m)).sort((a, b) => b.uid - a.uid),
			exhausted: found.length <= limit
		};
	});
}

/**
 * Lists one folder (a role such as `inbox` or a path) across the given accounts, newest first,
 * merged by date. An unreachable account is reported in `errors` instead of failing the list.
 */
export async function listMessages(
	accounts: MailAccount[],
	folder: string,
	filters: MessageFilters,
	cursorValue: string | null,
	limit = DEFAULT_PAGE_SIZE
): Promise<MessagePage> {
	const cursor = decodeCursor(cursorValue);
	const errors: AccountError[] = [];
	const pages = await Promise.all(
		accounts
			.filter((account) => cursor[account.id] !== 0)
			.map(async (account): Promise<AccountPage | null> => {
				try {
					const path = await resolveFolder(account, folder);
					if (!path) return { accountId: account.id, items: [], exhausted: true };
					return await fetchAccountPage(
						account,
						path,
						buildSearch(account, filters),
						cursor[account.id],
						limit
					);
				} catch (error) {
					errors.push({ accountId: account.id, message: errorMessage(error) });
					return null;
				}
			})
	);
	const merged = mergePages(
		pages.filter((page): page is AccountPage => page !== null),
		limit,
		cursor
	);
	return {
		messages: merged.messages,
		nextCursor: merged.cursor ? encodeCursor(merged.cursor) : null,
		errors
	};
}

/** Resolves a message ref to its account, which must belong to the user. */
export async function resolveRef(
	userId: string,
	ref: string
): Promise<{ account: MailAccount; locator: MessageLocator }> {
	const locator = decodeMessageRef(ref);
	return { account: await getAccount(userId, locator.accountId), locator };
}

function assertSameMailbox(mailbox: MailboxObject, locator: MessageLocator): void {
	if (String(mailbox.uidValidity) !== locator.uidValidity) {
		throw new MailError('This folder changed on the server. Reload the message list.', 409);
	}
}

/** Messages up to this size arrive whole with their structure, in one round trip. */
const WHOLE_MESSAGE_BYTES = 256 * 1024;
const DOWNLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * The message's source as far as reading it needs: small messages whole, larger ones rebuilt from
 * their body text, calendar parts, and embedded images. Attachments stay on the server.
 */
async function fetchForReading(account: MailAccount, locator: MessageLocator) {
	return withMailbox(account, locator.path, async (client, mailbox) => {
		assertSameMailbox(mailbox, locator);
		const uid = String(locator.uid);
		const message = await client.fetchOne(
			uid,
			{ ...SUMMARY_FETCH, size: true, source: { start: 0, maxLength: WHOLE_MESSAGE_BYTES } },
			{ uid: true }
		);
		if (!message || !message.source) throw new MailError('This message no longer exists.', 404);
		const plan = planMessage(message.bodyStructure);
		if ((message.size ?? Infinity) <= WHOLE_MESSAGE_BYTES) {
			return { message, mailbox, plan, source: message.source };
		}
		const rest = plan.whole
			? await client.fetchOne(uid, { source: true }, { uid: true })
			: await client.fetchOne(uid, { headers: true, bodyParts: plan.fetch }, { uid: true });
		if (!rest) throw new MailError('This message no longer exists.', 404);
		const source =
			plan.whole || !message.bodyStructure
				? rest.source
				: assembleSource(
						rest.headers ?? Buffer.alloc(0),
						message.bodyStructure,
						rest.bodyParts ?? new Map()
					);
		if (!source) throw new MailError('This message no longer exists.', 404);
		return { message, mailbox, plan, source };
	});
}

function parsedAddresses(value: AddressObject | AddressObject[] | undefined): Address[] {
	const list = Array.isArray(value) ? value : value ? [value] : [];
	return list.flatMap((group) =>
		group.value.flatMap((entry) =>
			entry.address
				? [{ name: entry.name ?? '', address: entry.address }]
				: (entry.group ?? []).flatMap((member) =>
						member.address ? [{ name: member.name ?? '', address: member.address }] : []
					)
		)
	);
}

function references(parsed: ParsedMail): string[] {
	const value = parsed.references;
	const list = Array.isArray(value) ? value : value ? value.split(/\s+/) : [];
	return list.filter(Boolean);
}

export interface ReadMessage {
	detail: MessageDetail;
	/** The parsed message without its attachments' content; see `getAttachments`. */
	parsed: ParsedMail;
}

function attachmentName(part: StructurePart): string {
	return part.filename ?? `attachment-${part.partId}`;
}

async function readMessage(account: MailAccount, locator: MessageLocator): Promise<ReadMessage> {
	const { message, mailbox, plan, source } = await fetchForReading(account, locator);
	const parsed = await simpleParser(source);
	const summary = toSummary(account, locator.path, mailbox, message);
	const html = parsed.html ? sanitizeEmailHtml(parsed.html) : null;
	const calendar = findCalendarPart(parsed.attachments);
	const invitation = calendar ? parseInvitation(calendar, account.email) : null;
	const detail: MessageDetail = {
		...summary,
		from: parsedAddresses(parsed.from)[0] ?? summary.from,
		to: parsedAddresses(parsed.to),
		cc: parsedAddresses(parsed.cc),
		bcc: parsedAddresses(parsed.bcc),
		replyTo: parsedAddresses(parsed.replyTo),
		subject: parsed.subject ?? summary.subject,
		messageId: parsed.messageId ?? summary.messageId,
		inReplyTo: parsed.inReplyTo ?? null,
		references: references(parsed),
		text: parsed.text ?? '',
		html: html?.html ?? textToHtml(parsed.text ?? ''),
		hasRemoteImages: html?.hasRemoteImages ?? false,
		// An unnamed calendar part is the invitation's machine-readable form, shown as the invitation.
		attachments: plan.attachments.flatMap((part) =>
			invitation && !part.filename && isCalendarPart(part)
				? []
				: [
						{
							partId: part.partId,
							filename: attachmentName(part),
							contentType: part.contentType,
							size: part.size
						}
					]
		),
		invitation
	};
	return { detail, parsed };
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

interface CacheEntry {
	value: Promise<ReadMessage>;
	read?: ReadMessage;
	bytes: number;
	expires: number;
}

/**
 * Recently read messages, least recently used first. A UID's content never changes within one
 * UIDVALIDITY; flags are kept current by `setFlags`, and moved or deleted messages are dropped.
 */
const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function cacheKey(accountId: string, path: string, uidValidity: string, uid: number): string {
	return JSON.stringify([accountId, path, uidValidity, uid]);
}

function forget(key: string): void {
	const entry = cache.get(key);
	if (!entry) return;
	cache.delete(key);
	cachedBytes -= entry.bytes;
}

function readSize({ detail, parsed }: ReadMessage): number {
	const strings = [detail.html, detail.text, parsed.text, parsed.textAsHtml, parsed.html || ''];
	const text = strings.reduce((sum, value) => sum + (value?.length ?? 0), 0);
	return 2 * text + parsed.attachments.reduce((sum, a) => sum + a.content.length, 0);
}

/**
 * Fetches and parses one message, from the cache when it was read recently. Reading never marks
 * it as seen; see `setFlags`.
 */
export function getMessage(account: MailAccount, locator: MessageLocator): Promise<ReadMessage> {
	const key = cacheKey(account.id, locator.path, locator.uidValidity, locator.uid);
	const hit = cache.get(key);
	if (hit && hit.expires > Date.now()) {
		cache.delete(key);
		cache.set(key, hit);
		return hit.value;
	}
	forget(key);
	const entry: CacheEntry = {
		value: readMessage(account, locator),
		bytes: 0,
		expires: Date.now() + CACHE_TTL_MS
	};
	cache.set(key, entry);
	entry.value.then(
		(read) => {
			if (cache.get(key) !== entry) return;
			entry.read = read;
			entry.bytes = readSize(read);
			cachedBytes += entry.bytes;
			for (const [oldest] of cache) {
				if (cachedBytes <= CACHE_MAX_BYTES) break;
				forget(oldest);
			}
		},
		() => {
			if (cache.get(key) === entry) forget(key);
		}
	);
	return entry.value;
}

/** Downloads attachments by part ID, in the given order. */
export async function getAttachments(
	account: MailAccount,
	locator: MessageLocator,
	partIds: string[]
): Promise<{ filename: string; contentType: string; content: Buffer }[]> {
	if (!partIds.length) return [];
	return withMailbox(account, locator.path, async (client, mailbox) => {
		assertSameMailbox(mailbox, locator);
		const uid = String(locator.uid);
		const message = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
		if (!message) throw new MailError('This message no longer exists.', 404);
		const { attachments } = planMessage(message.bodyStructure);
		const files = [];
		for (const partId of partIds) {
			const part = attachments.find((a) => a.partId === partId);
			if (!part) throw new MailError('Attachment not found.', 404);
			const { content } = await client.download(uid, partId, {
				uid: true,
				chunkSize: DOWNLOAD_CHUNK_BYTES
			});
			files.push({
				filename: attachmentName(part),
				contentType: part.contentType || 'application/octet-stream',
				content: content ? Buffer.concat(await content.toArray()) : Buffer.alloc(0)
			});
		}
		return files;
	});
}

export async function getAttachment(
	account: MailAccount,
	locator: MessageLocator,
	partId: string
): Promise<{ filename: string; contentType: string; content: Buffer }> {
	const [file] = await getAttachments(account, locator, [partId]);
	return file;
}

interface RefGroup {
	account: MailAccount;
	path: string;
	uidValidity: string;
	uids: number[];
}

/** Groups refs by mailbox so each group is one IMAP command. */
export async function groupRefs(userId: string, refs: string[]): Promise<RefGroup[]> {
	const groups = new Map<string, RefGroup>();
	const accounts = new Map<string, MailAccount>();
	for (const ref of refs) {
		const locator = decodeMessageRef(ref);
		let account = accounts.get(locator.accountId);
		if (!account) {
			account = await getAccount(userId, locator.accountId);
			accounts.set(account.id, account);
		}
		const key = JSON.stringify([locator.accountId, locator.path, locator.uidValidity]);
		const group = groups.get(key) ?? {
			account,
			path: locator.path,
			uidValidity: locator.uidValidity,
			uids: []
		};
		group.uids.push(locator.uid);
		groups.set(key, group);
	}
	return [...groups.values()];
}

function inGroup<T>(group: RefGroup, fn: Parameters<typeof withMailbox<T>>[2]): Promise<T> {
	return withMailbox(group.account, group.path, async (client, mailbox) => {
		assertSameMailbox(mailbox, { ...group, accountId: group.account.id, uid: 0 });
		return fn(client, mailbox);
	});
}

export async function setFlags(
	groups: RefGroup[],
	flags: { seen?: boolean; flagged?: boolean }
): Promise<void> {
	for (const group of groups) {
		await inGroup(group, async (client) => {
			for (const [flag, on] of [
				['\\Seen', flags.seen],
				['\\Flagged', flags.flagged]
			] as const) {
				if (on === undefined) continue;
				if (on) await client.messageFlagsAdd(group.uids, [flag], { uid: true });
				else await client.messageFlagsRemove(group.uids, [flag], { uid: true });
			}
		});
		for (const uid of group.uids) {
			const key = cacheKey(group.account.id, group.path, group.uidValidity, uid);
			const read = cache.get(key)?.read;
			if (!read) {
				forget(key);
				continue;
			}
			if (flags.seen !== undefined) read.detail.unread = !flags.seen;
			if (flags.flagged !== undefined) read.detail.starred = flags.flagged;
		}
	}
}

function forgetGroup(group: RefGroup): void {
	for (const uid of group.uids) {
		forget(cacheKey(group.account.id, group.path, group.uidValidity, uid));
	}
}

export type MoveTarget = 'archive' | 'trash' | 'spam' | 'inbox' | { path: string };

/** Moves messages; a no-op for messages already in the target folder. */
export async function moveMessages(groups: RefGroup[], target: MoveTarget): Promise<void> {
	for (const group of groups) {
		const destination =
			target === 'archive'
				? await ensureArchiveFolder(group.account)
				: typeof target === 'string'
					? await requireFolder(group.account, target)
					: await requireFolder(group.account, target.path);
		if (destination === group.path) continue;
		forgetGroup(group);
		await inGroup(group, (client) => client.messageMove(group.uids, destination, { uid: true }));
	}
}

/** Permanently deletes messages (flag \Deleted and expunge). Only offered for Trash and Spam. */
export async function deleteMessages(groups: RefGroup[]): Promise<void> {
	for (const group of groups) {
		forgetGroup(group);
		await inGroup(group, (client) => client.messageDelete(group.uids, { uid: true }));
	}
}

/**
 * The conversation around a message, oldest first. Gmail threads come from X-GM-THRID in All Mail;
 * elsewhere, Inbox, Sent, and Archive are searched for the Message-ID chain in both directions.
 */
export async function getThread(
	account: MailAccount,
	locator: MessageLocator,
	detail: Pick<MessageDetail, 'messageId' | 'references' | 'inReplyTo'>
): Promise<MessageSummary[]> {
	const found = new Map<string, MessageSummary>();
	const add = (summary: MessageSummary) => found.set(summary.messageId ?? summary.ref, summary);

	if (account.provider === 'gmail') {
		const threadId = await withMailbox(account, locator.path, async (client) => {
			const message = await client.fetchOne(String(locator.uid), { threadId: true }, { uid: true });
			return message ? message.threadId : undefined;
		});
		const allMail = await resolveFolder(account, 'archive');
		if (threadId && allMail) {
			await withMailbox(account, allMail, async (client, mailbox) => {
				const uids = (await client.search({ threadId }, { uid: true })) || [];
				if (!uids.length) return;
				for (const message of await client.fetchAll(uids, SUMMARY_FETCH, { uid: true })) {
					add(toSummary(account, allMail, mailbox, message));
				}
			});
		}
	} else {
		const ids = [
			...new Set([...detail.references, detail.inReplyTo, detail.messageId].filter(Boolean))
		].slice(-20) as string[];
		const criteria: SearchObject[] = ids.map((id) => ({ header: { 'message-id': id } }));
		if (detail.messageId) criteria.push({ header: { references: detail.messageId } });
		if (!criteria.length) return [];
		const query: SearchObject = criteria.length === 1 ? criteria[0] : { or: criteria };
		for (const role of ['inbox', 'sent', 'archive'] as const) {
			const path = await resolveFolder(account, role);
			if (!path) continue;
			await withMailbox(account, path, async (client, mailbox) => {
				const uids = (await client.search(query, { uid: true })) || [];
				if (!uids.length) return;
				for (const message of await client.fetchAll(uids, SUMMARY_FETCH, { uid: true })) {
					add(toSummary(account, path, mailbox, message));
				}
			});
		}
	}
	return [...found.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}
