import type {
	FetchMessageObject,
	ImapFlow,
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
	MessageSummary,
	ThreadKeys
} from '../../mail-types';
import { getAccount } from './accounts';
import { bodyText, previewOf } from './body-text';
import { errorMessage, MailError, MessageGoneError } from './errors';
import * as ews from './ews/messages';
import { ensureArchiveFolder, getFolders, requireFolder, resolveFolder } from './folders';
import { withMailbox } from './imap';
import { ownResponse } from './invitation-responses';
import { findCalendarPart, isCalendarPart, parseInvitation } from './invitations';
import { decodeCursor, encodeCursor, mergePages, trimPage, type AccountPage } from './merge';
import {
	decodeMessageRef,
	encodeMessageRef,
	ewsLocator,
	imapLocator,
	type ImapLocator,
	type MessageLocator
} from './message-ref';
import { sanitizeEmailHtml, textToHtml } from './render';
import { inStages } from './stages';
import {
	assembleSource,
	decodePartStart,
	planMessage,
	previewPart,
	type PreviewPart,
	type StructurePart
} from './structure';
import type { MailAccount } from './types';

export const DEFAULT_PAGE_SIZE = 50;

/** imapflow reports a refused or interrupted command as `false` (or `undefined`) instead of throwing. */
export function required<T>(result: T | false | undefined, account: MailAccount, what: string): T {
	if (result === false || result === undefined) {
		throw new MailError(`${account.email}: the mail server could not ${what}.`, 502);
	}
	return result;
}

/** The UIDs matching a search in the selected mailbox; a failed search throws instead of finding none. */
export async function searchUids(
	client: ImapFlow,
	account: MailAccount,
	query: SearchObject
): Promise<number[]> {
	return required(await client.search(query, { uid: true }), account, 'search the folder');
}

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

/** Summaries with their conversation keys: Gmail's or the server's thread ID, and References. */
const THREAD_FETCH = { ...SUMMARY_FETCH, threadId: true, headers: ['references'] };

const MESSAGE_ID = /<[^<>\s]+>/g;

/** The Message-IDs of a fetched `References` header. */
export function referencesOf(headers: Buffer | undefined): string[] {
	const value = headers?.toString('utf8').replace(/^references:/i, '') ?? '';
	return value.match(MESSAGE_ID) ?? [];
}

/** Only Gmail's thread ID is used; other servers' THREADID would disagree with `getThread`. */
function threadKeys(account: MailAccount, message: FetchMessageObject): ThreadKeys {
	return {
		id: account.provider === 'gmail' ? (message.threadId ?? null) : null,
		inReplyTo: message.envelope?.inReplyTo ?? null,
		references: referencesOf(message.headers)
	};
}

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
			kind: 'imap',
			accountId: account.id,
			path,
			uidValidity: String(mailbox.uidValidity),
			uid: message.uid
		}),
		accountId: account.id,
		cursor: message.uid,
		from: address(envelope.from?.[0]),
		to: addresses(envelope.to),
		subject: envelope.subject ?? '',
		date: isoDate(message.internalDate ?? envelope.date),
		unread: !flags.has('\\Seen'),
		starred: flags.has('\\Flagged'),
		draft: flags.has('\\Draft'),
		hasAttachments: hasAttachment(message.bodyStructure),
		messageId: envelope.messageId ?? null,
		...(message.headers || message.threadId ? { thread: threadKeys(account, message) } : {})
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
	limit: number,
	threads: boolean
): Promise<AccountPage> {
	return withMailbox(account, path, async (client, mailbox) => {
		if (beforeUid !== undefined && beforeUid <= 1) {
			return { accountId: account.id, items: [], exhausted: true, last: null };
		}
		const fields = threads ? THREAD_FETCH : SUMMARY_FETCH;
		const toItems = (fetched: FetchMessageObject[]) =>
			fetched.map((m) => toSummary(account, path, mailbox, m)).sort((a, b) => b.cursor - a.cursor);
		// The newest messages of an unfiltered folder are its last sequence numbers, which rise with
		// UIDs; SEARCH ALL would return every UID in the folder.
		if (beforeUid === undefined && Object.keys(search).length === 0) {
			const exists = mailbox.exists;
			if (!exists) return { accountId: account.id, items: [], exhausted: true, last: null };
			const fetched = await client.fetchAll(`${Math.max(1, exists - limit + 1)}:${exists}`, fields);
			const items = toItems(fetched);
			return {
				accountId: account.id,
				items,
				exhausted: exists <= limit,
				last: items.at(-1)?.cursor ?? null
			};
		}
		const query: SearchObject = { ...search };
		if (beforeUid !== undefined) query.uid = `1:${beforeUid - 1}`;
		if (Object.keys(query).length === 0) query.all = true;
		const found = (await searchUids(client, account, query)).sort((a, b) => a - b);
		const picked = found.slice(-limit);
		if (!picked.length) return { accountId: account.id, items: [], exhausted: true, last: null };
		const fetched = await client.fetchAll(picked, fields, { uid: true });
		return {
			accountId: account.id,
			items: toItems(fetched),
			exhausted: found.length <= limit,
			last: picked[0]
		};
	});
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Filters for an account that may only show messages received from `notBefore` on. The server
 * search starts a day early, since IMAP SINCE compares whole days in the server's time zone; the
 * exact cut is `trimPage`.
 */
function withinWindow(filters: MessageFilters, notBefore: Date): MessageFilters {
	const earliest = new Date(notBefore.getTime() - DAY_MS);
	const since = filters.since && filters.since > earliest ? filters.since : earliest;
	return { ...filters, since };
}

export interface ListOptions {
	/** Per account ID: leave out messages received before this time (MCP time windows). */
	notBefore?: Map<string, Date>;
	/** Include each message's conversation keys (`MessageSummary.thread`). */
	threads?: boolean;
}

/** One account's page of a folder (a role such as `inbox` or a path), newest first. */
async function accountPage(
	account: MailAccount,
	folder: string,
	filters: MessageFilters,
	beforeCursor: number | undefined,
	limit: number,
	options: ListOptions
): Promise<AccountPage> {
	const path = await resolveFolder(account, folder);
	if (!path) return { accountId: account.id, items: [], exhausted: true, last: null };
	const notBefore = options.notBefore?.get(account.id);
	const accountFilters = notBefore ? withinWindow(filters, notBefore) : filters;
	const page =
		account.provider === 'exchange'
			? await ews.listPage(account, path, accountFilters, beforeCursor, limit, {
					threads: options.threads
				})
			: await fetchAccountPage(
					account,
					path,
					buildSearch(account, accountFilters),
					beforeCursor,
					limit,
					options.threads ?? false
				);
	return notBefore ? trimPage(page, notBefore, account.provider === 'exchange') : page;
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
	limit = DEFAULT_PAGE_SIZE,
	options: ListOptions = {}
): Promise<MessagePage> {
	const cursor = decodeCursor(cursorValue);
	const errors: AccountError[] = [];
	const pages = await Promise.all(
		accounts
			.filter((account) => cursor[account.id] !== 0)
			.map(async (account): Promise<AccountPage | null> => {
				try {
					return await accountPage(account, folder, filters, cursor[account.id], limit, options);
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
		errors,
		pending: []
	};
}

type AccountResult = { page: AccountPage } | { error: AccountError };

function mergeResults(results: Iterable<AccountResult>, pending: string[]): MessagePage {
	const pages: AccountPage[] = [];
	const errors: AccountError[] = [];
	for (const result of results) {
		if ('page' in result) pages.push(result.page);
		else errors.push(result.error);
	}
	// Accounts still loading or failed count as done for paging, so "Load more" never puts their
	// newest mail below older mail of the others.
	const merged = mergePages(
		pages,
		DEFAULT_PAGE_SIZE,
		Object.fromEntries([...pending, ...errors.map((e) => e.accountId)].map((id) => [id, 0]))
	);
	return {
		messages: merged.messages,
		nextCursor: merged.cursor ? encodeCursor(merged.cursor) : null,
		errors,
		pending
	};
}

/**
 * The first page of a folder for the web app, in the two stages of `inStages`: `early` without
 * the accounts that are slow to answer (named in `pending`), `late` with all of them.
 */
export function listMessagesInStages(
	accounts: MailAccount[],
	folder: string,
	filters: MessageFilters
): { early: Promise<MessagePage>; late: Promise<MessagePage | null> } {
	const stages = inStages<AccountResult>(
		accounts,
		async (account) => ({
			page: await accountPage(account, folder, filters, undefined, DEFAULT_PAGE_SIZE, {})
		}),
		(account, error) => ({ error: { accountId: account.id, message: errorMessage(error) } })
	);
	return {
		early: stages.early.then(({ results, pending }) => mergeResults(results.values(), pending)),
		late: stages.late.then((results) => results && mergeResults(results.values(), []))
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

function assertSameMailbox(mailbox: MailboxObject, locator: ImapLocator): void {
	if (String(mailbox.uidValidity) !== locator.uidValidity) {
		throw new MessageGoneError('This folder changed on the server. Reload the message list.', 409);
	}
}

/** Messages up to this size arrive whole with their structure, in one round trip. */
const WHOLE_MESSAGE_BYTES = 256 * 1024;
const DOWNLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * The message's source as far as reading it needs: small messages whole, larger ones rebuilt from
 * their body text, calendar parts, and embedded images. Attachments stay on the server.
 */
async function fetchForReading(account: MailAccount, locator: ImapLocator) {
	return withMailbox(account, locator.path, async (client, mailbox) => {
		assertSameMailbox(mailbox, locator);
		const uid = String(locator.uid);
		const message = await client.fetchOne(
			uid,
			{ ...SUMMARY_FETCH, size: true, source: { start: 0, maxLength: WHOLE_MESSAGE_BYTES } },
			{ uid: true }
		);
		if (!message || !message.source) throw new MessageGoneError();
		const plan = planMessage(message.bodyStructure);
		if ((message.size ?? Infinity) <= WHOLE_MESSAGE_BYTES) {
			return { message, mailbox, plan, source: message.source };
		}
		const rest = plan.whole
			? await client.fetchOne(uid, { source: true }, { uid: true })
			: await client.fetchOne(uid, { headers: true, bodyParts: plan.fetch }, { uid: true });
		if (!rest) throw new MessageGoneError();
		const source =
			plan.whole || !message.bodyStructure
				? rest.source
				: assembleSource(
						rest.headers ?? Buffer.alloc(0),
						message.bodyStructure,
						rest.bodyParts ?? new Map()
					);
		if (!source) throw new MessageGoneError();
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
	/** `detail.text` is the clean plain text of the body (`body-text.ts`). */
	detail: MessageDetail;
	/** The body above the first quoted message, or null when nothing is quoted. */
	newText: string | null;
	/** The Date header, when the message was sent. */
	sentAt: Date | null;
	/** The invitation's iCalendar text, when the message carries one. */
	calendar: string | null;
}

function attachmentName(part: StructurePart): string {
	return part.filename ?? `attachment-${part.partId}`;
}

/** Embedded images inlined as data URIs, at most this much per message (as mailparser does). */
const MAX_INLINED_BYTES = 20 * 1024 * 1024;

/** Replaces `cid:` references to embedded images with data URIs. */
function inlineImages(html: string, parsed: ParsedMail): string {
	const images = new Map(
		parsed.attachments
			.filter((a) => a.cid && /^image\/[\w.+-]+$/i.test(a.contentType))
			.map((a) => [a.cid!, a] as const)
	);
	let budget = MAX_INLINED_BYTES;
	return html.replace(/\bcid:([^'"\s]{1,256})/g, (match, cid: string) => {
		const image = images.get(cid);
		if (!image) return match;
		const uri = `data:${image.contentType};base64,${image.content.toString('base64')}`;
		if (uri.length > budget) return match;
		budget -= uri.length;
		return uri;
	});
}

/** File names of embedded images by Content-ID, for `[image: name]` in the text. */
function imageNames(parsed: ParsedMail): Map<string, string> {
	return new Map(
		parsed.attachments.flatMap((a) => (a.cid && a.filename ? [[a.cid, a.filename] as const] : []))
	);
}

async function readImapMessage(account: MailAccount, locator: ImapLocator): Promise<ReadMessage> {
	const { message, mailbox, plan, source } = await fetchForReading(account, locator);
	// Images stay `cid:` links until the text is taken, which names them by file name.
	const parsed = await simpleParser(source, { skipImageLinks: true });
	const summary = toSummary(account, locator.path, mailbox, message);
	const subject = parsed.subject ?? summary.subject;
	const body = bodyText({
		html: parsed.html || null,
		text: parsed.text ?? '',
		subject,
		images: imageNames(parsed)
	});
	const html = parsed.html ? sanitizeEmailHtml(inlineImages(parsed.html, parsed)) : null;
	const calendar = findCalendarPart(parsed.attachments);
	const invitation = calendar ? parseInvitation(calendar, account.email) : null;
	const detail: MessageDetail = {
		...summary,
		from: parsedAddresses(parsed.from)[0] ?? summary.from,
		to: parsedAddresses(parsed.to),
		cc: parsedAddresses(parsed.cc),
		bcc: parsedAddresses(parsed.bcc),
		replyTo: parsedAddresses(parsed.replyTo),
		subject,
		messageId: parsed.messageId ?? summary.messageId,
		inReplyTo: parsed.inReplyTo ?? null,
		references: references(parsed),
		text: body.text,
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
	return { detail, newText: body.newText, sentAt: parsed.date ?? null, calendar };
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
 * Recently read messages by ref, least recently used first. A message's content never changes
 * under one ref (an IMAP UID within its UIDVALIDITY, an Exchange item ID); flags are kept current
 * by `setFlags`, and moved or deleted messages are dropped.
 */
const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function forget(key: string): void {
	const entry = cache.get(key);
	if (!entry) return;
	cache.delete(key);
	cachedBytes -= entry.bytes;
}

function readSize({ detail, newText, calendar }: ReadMessage): number {
	return (
		2 * (detail.html.length + detail.text.length + (newText?.length ?? 0) + (calendar?.length ?? 0))
	);
}

/** Drops a message from the read cache, e.g. after it changed in a way `setFlags` does not cover. */
export function forgetMessage(ref: string): void {
	forget(ref);
}

/** A read with the user's recorded answer to its invitation, which the calendar part lacks. */
async function withOwnResponse(account: MailAccount, read: ReadMessage): Promise<ReadMessage> {
	const { invitation } = read.detail;
	const response = invitation ? await ownResponse(account.id, invitation) : null;
	if (invitation && response) invitation.ownStatus = response;
	return read;
}

/**
 * Fetches and parses one message, from the cache when it was read recently (unless `fresh`).
 * Reading never marks it as seen; see `setFlags`.
 */
export function getMessage(
	account: MailAccount,
	locator: MessageLocator,
	options: { fresh?: boolean } = {}
): Promise<ReadMessage> {
	const key = encodeMessageRef(locator);
	const hit = cache.get(key);
	if (hit && hit.expires > Date.now() && !options.fresh) {
		cache.delete(key);
		cache.set(key, hit);
		return hit.value;
	}
	forget(key);
	const entry: CacheEntry = {
		value: (account.provider === 'exchange'
			? ews.readMessage(account, ewsLocator(locator))
			: readImapMessage(account, imapLocator(locator))
		).then((read) => withOwnResponse(account, read)),
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
	messageLocator: MessageLocator,
	partIds: string[]
): Promise<{ filename: string; contentType: string; content: Buffer }[]> {
	if (!partIds.length) return [];
	if (account.provider === 'exchange') {
		ewsLocator(messageLocator);
		// Exchange fetches attachments by their own IDs; only those of this message may be fetched.
		const { detail } = await getMessage(account, messageLocator);
		const listed = new Set(detail.attachments.map((a) => a.partId));
		if (partIds.some((partId) => !listed.has(partId))) {
			throw new MailError('Attachment not found.', 404);
		}
		return ews.getAttachments(account, partIds);
	}
	const locator = imapLocator(messageLocator);
	return withMailbox(account, locator.path, async (client, mailbox) => {
		assertSameMailbox(mailbox, locator);
		const uid = String(locator.uid);
		const message = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
		if (!message) throw new MessageGoneError();
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

/**
 * When messages were received (`MessageSummary.date`), by ref, without reading them. Messages that
 * no longer exist, or whose folder changed its UIDVALIDITY, are missing.
 */
export async function receivedDates(
	account: MailAccount,
	locators: MessageLocator[]
): Promise<Map<string, string>> {
	const dates = new Map<string, string>();
	if (account.provider === 'exchange') {
		const items = locators.map(ewsLocator);
		const found = await ews.receivedDates(
			account,
			items.map((l) => l.itemId)
		);
		items.forEach((locator, index) => {
			const date = found[index];
			if (date) dates.set(encodeMessageRef(locator), date);
		});
		return dates;
	}
	const mailboxes = new Map<string, ImapLocator[]>();
	for (const locator of locators.map(imapLocator)) {
		const key = JSON.stringify([locator.path, locator.uidValidity]);
		mailboxes.set(key, [...(mailboxes.get(key) ?? []), locator]);
	}
	for (const group of mailboxes.values()) {
		const { path, uidValidity } = group[0];
		await withMailbox(account, path, async (client, mailbox) => {
			if (String(mailbox.uidValidity) !== uidValidity) return;
			const uids = group.map((l) => l.uid);
			for (const message of await client.fetchAll(
				uids,
				{ uid: true, internalDate: true },
				{ uid: true }
			)) {
				const locator = group.find((l) => l.uid === message.uid);
				if (locator) dates.set(encodeMessageRef(locator), isoDate(message.internalDate));
			}
		});
	}
	return dates;
}

type RefGroup =
	| { kind: 'imap'; account: MailAccount; path: string; uidValidity: string; uids: number[] }
	| { kind: 'ews'; account: MailAccount; path: string; itemIds: string[] };

/** Groups refs by mailbox (IMAP) or account and folder (Exchange), one command per group. */
export async function groupRefs(userId: string, refs: string[]): Promise<RefGroup[]> {
	const groups = new Map<string, RefGroup>();
	const accounts = new Map<string, MailAccount>();
	for (const ref of refs) {
		const decoded = decodeMessageRef(ref);
		let account = accounts.get(decoded.accountId);
		if (!account) {
			account = await getAccount(userId, decoded.accountId);
			accounts.set(account.id, account);
		}
		if (account.provider === 'exchange') {
			const locator = ewsLocator(decoded);
			const key = JSON.stringify([locator.accountId, locator.path]);
			const group = groups.get(key) ?? {
				kind: 'ews',
				account,
				path: locator.path,
				itemIds: []
			};
			if (group.kind === 'ews') group.itemIds.push(locator.itemId);
			groups.set(key, group);
		} else {
			const locator = imapLocator(decoded);
			const key = JSON.stringify([locator.accountId, locator.path, locator.uidValidity]);
			const group = groups.get(key) ?? {
				kind: 'imap',
				account,
				path: locator.path,
				uidValidity: locator.uidValidity,
				uids: []
			};
			if (group.kind === 'imap') group.uids.push(locator.uid);
			groups.set(key, group);
		}
	}
	return [...groups.values()];
}

function groupLocators(group: RefGroup): MessageLocator[] {
	const accountId = group.account.id;
	return group.kind === 'imap'
		? group.uids.map((uid) => ({
				kind: 'imap',
				accountId,
				path: group.path,
				uidValidity: group.uidValidity,
				uid
			}))
		: group.itemIds.map((itemId) => ({ kind: 'ews', accountId, path: group.path, itemId }));
}

function inGroup<T>(
	group: Extract<RefGroup, { kind: 'imap' }>,
	fn: Parameters<typeof withMailbox<T>>[2]
): Promise<T> {
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
		if (group.kind === 'ews') {
			await ews.setFlags(group.account, group.itemIds, flags);
		} else {
			await inGroup(group, async (client) => {
				for (const [flag, on] of [
					['\\Seen', flags.seen],
					['\\Flagged', flags.flagged]
				] as const) {
					if (on === undefined) continue;
					const done = on
						? await client.messageFlagsAdd(group.uids, [flag], { uid: true })
						: await client.messageFlagsRemove(group.uids, [flag], { uid: true });
					required(done, group.account, 'update the messages');
				}
			});
		}
		for (const locator of groupLocators(group)) {
			const key = encodeMessageRef(locator);
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

/** Marks messages as answered after a reply was sent. */
export async function markAnswered(groups: RefGroup[]): Promise<void> {
	for (const group of groups) {
		if (group.kind === 'ews') await ews.markAnswered(group.account, group.itemIds);
		else {
			await inGroup(group, async (client) =>
				required(
					await client.messageFlagsAdd(group.uids, ['\\Answered'], { uid: true }),
					group.account,
					'mark the message answered'
				)
			);
		}
	}
}

function forgetGroup(group: RefGroup): void {
	for (const locator of groupLocators(group)) forget(encodeMessageRef(locator));
}

export type MoveTarget = 'archive' | 'trash' | 'spam' | 'inbox' | { path: string };

/**
 * The refs of moved IMAP messages in their new folder, from the server's COPYUID answer (UIDPLUS);
 * messages it does not report are missing.
 */
export function movedImapRefs(
	group: Extract<RefGroup, { kind: 'imap' }>,
	moved: { destination: string; uidValidity?: bigint; uidMap?: Map<number, number> }
): Map<string, string> {
	const refs = new Map<string, string>();
	if (moved.uidValidity === undefined || !moved.uidMap) return refs;
	for (const locator of groupLocators(group)) {
		if (locator.kind !== 'imap') continue;
		const uid = moved.uidMap.get(locator.uid);
		if (!uid) continue;
		refs.set(
			encodeMessageRef(locator),
			encodeMessageRef({
				kind: 'imap',
				accountId: group.account.id,
				path: moved.destination,
				uidValidity: String(moved.uidValidity),
				uid
			})
		);
	}
	return refs;
}

/** Gmail folders that archiving moves out of; other labels only lose the Inbox label. */
const GMAIL_MOVE_ROLES = ['inbox', 'spam', 'trash'] as const;

/**
 * Moves messages; a no-op for messages already in the target folder. Archiving on Gmail outside
 * Inbox, Spam, and Trash removes the Inbox label instead (Gmail's archive), and the messages stay
 * where they are. Returns the new ref of each moved message by its old ref, as far as the server
 * reports them.
 */
export async function moveMessages(
	groups: RefGroup[],
	target: MoveTarget
): Promise<Map<string, string>> {
	const moved = new Map<string, string>();
	for (const group of groups) {
		const destination =
			target === 'archive'
				? await ensureArchiveFolder(group.account)
				: typeof target === 'string'
					? await requireFolder(group.account, target)
					: await requireFolder(group.account, target.path);
		if (destination === group.path) continue;
		if (
			target === 'archive' &&
			group.kind === 'imap' &&
			group.account.provider === 'gmail' &&
			!(await rolePaths(group.account, GMAIL_MOVE_ROLES)).includes(group.path)
		) {
			await inGroup(group, async (client) =>
				required(
					await client.messageFlagsRemove(group.uids, ['\\Inbox'], { uid: true, useLabels: true }),
					group.account,
					'archive the messages'
				)
			);
			continue;
		}
		forgetGroup(group);
		if (group.kind === 'ews') {
			const ids = await ews.moveItems(group.account, group.itemIds, destination);
			group.itemIds.forEach((itemId, index) => {
				const newId = ids[index];
				if (!newId) return;
				const accountId = group.account.id;
				moved.set(
					encodeMessageRef({ kind: 'ews', accountId, path: group.path, itemId }),
					encodeMessageRef({ kind: 'ews', accountId, path: destination, itemId: newId })
				);
			});
		} else {
			const result = await inGroup(group, async (client) =>
				required(
					await client.messageMove(group.uids, destination, { uid: true }),
					group.account,
					'move the messages'
				)
			);
			for (const [from, to] of movedImapRefs(group, { ...result, destination })) {
				moved.set(from, to);
			}
		}
		// A read while the move ran may have cached the old ref again.
		forgetGroup(group);
	}
	return moved;
}

/** Permanently deletes messages (flag \Deleted and expunge). Only offered for Trash and Spam. */
export async function deleteMessages(groups: RefGroup[]): Promise<void> {
	for (const group of groups) {
		forgetGroup(group);
		if (group.kind === 'ews') await ews.deleteItems(group.account, group.itemIds);
		else {
			await inGroup(group, async (client) =>
				required(
					await client.messageDelete(group.uids, { uid: true }),
					group.account,
					'delete the messages'
				)
			);
		}
		// A read while the delete ran may have cached the old ref again.
		forgetGroup(group);
	}
}

/** Criteria per IMAP SEARCH; IMAP ORs only two keys at a time, so the query nests. */
const CRITERIA_PER_SEARCH = 25;
/** Conversation members fetched at most per folder. */
const MAX_MEMBERS = 500;

/**
 * Messages in the given folders matching any of the criteria, with conversation keys, oldest
 * last. The same message in several folders is found once per folder.
 */
async function searchFolders(
	account: MailAccount,
	paths: string[],
	criteria: SearchObject[]
): Promise<MessageSummary[]> {
	const found: MessageSummary[] = [];
	if (!criteria.length) return found;
	for (const path of paths) {
		await withMailbox(account, path, async (client, mailbox) => {
			const uids = new Set<number>();
			for (let i = 0; i < criteria.length; i += CRITERIA_PER_SEARCH) {
				const chunk = criteria.slice(i, i + CRITERIA_PER_SEARCH);
				const query: SearchObject = chunk.length === 1 ? chunk[0] : { or: chunk };
				for (const uid of await searchUids(client, account, query)) uids.add(uid);
			}
			const picked = [...uids].sort((a, b) => a - b).slice(-MAX_MEMBERS);
			if (!picked.length) return;
			for (const message of await client.fetchAll(picked, THREAD_FETCH, { uid: true })) {
				found.push(toSummary(account, path, mailbox, message));
			}
		});
	}
	return found;
}

/**
 * Header searches for the conversations of these messages (servers without conversation IDs):
 * each message and every message it refers to, and the replies to any of them by References or
 * only by In-Reply-To (as automatic replies often do). Replies to an ancestor bring in siblings,
 * such as an automatic reply and the answer that followed it.
 */
export function conversationCriteria(
	messages: { messageId: string | null; inReplyTo: string | null; references: string[] }[]
): SearchObject[] {
	const criteria = new Map<string, SearchObject>();
	const add = (name: string, value: string) =>
		criteria.set(`${name} ${value}`, { header: { [name]: value } });
	for (const message of messages) {
		const ids = [...message.references.slice(-20), message.inReplyTo, message.messageId];
		for (const id of ids) {
			if (!id) continue;
			add('message-id', id);
			add('references', id);
			add('in-reply-to', id);
		}
	}
	return [...criteria.values()];
}

async function rolePaths(account: MailAccount, roles: readonly string[]): Promise<string[]> {
	const paths: string[] = [];
	for (const role of roles) {
		const path = await resolveFolder(account, role);
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

/** Folders whose messages make up a conversation where the server has no conversation index. */
const THREAD_ROLES = ['inbox', 'sent', 'archive'] as const;

/**
 * All messages of the conversations of listed messages (from `listMessages` with `threads`),
 * from every folder `getThread` would search, so both count the same messages: Exchange's
 * conversation index, Gmail's All Mail by X-GM-THRID, elsewhere Inbox, Sent, and Archive by
 * Message-ID headers.
 */
export async function conversationMembers(
	account: MailAccount,
	listed: MessageSummary[]
): Promise<MessageSummary[]> {
	const ids = [...new Set(listed.map((m) => m.thread?.id).filter((id): id is string => !!id))];
	if (account.provider === 'exchange') return ews.conversations(account, ids);
	if (account.provider === 'gmail') {
		const allMail = await resolveFolder(account, 'archive');
		if (!allMail || !ids.length) return [];
		return searchFolders(
			account,
			[allMail],
			ids.map((threadId) => ({ threadId }))
		);
	}
	const criteria = conversationCriteria(
		listed.map((m) => ({
			messageId: m.messageId,
			inReplyTo: m.thread?.inReplyTo ?? null,
			references: m.thread?.references ?? []
		}))
	);
	return searchFolders(account, await rolePaths(account, THREAD_ROLES), criteria);
}

/**
 * The conversation around a message, oldest first. Exchange keeps its own conversation index;
 * Gmail threads come from X-GM-THRID in All Mail, addressed in Inbox or Sent where they are
 * there too (archiving and moving act on those copies); elsewhere, Inbox, Sent, and Archive are
 * searched for the Message-ID chain in both directions.
 */
export async function getThread(
	account: MailAccount,
	messageLocator: MessageLocator,
	detail: Pick<MessageDetail, 'messageId' | 'references' | 'inReplyTo'>
): Promise<MessageSummary[]> {
	if (account.provider === 'exchange') return ews.getThread(account, ewsLocator(messageLocator));
	const locator = imapLocator(messageLocator);
	let found: MessageSummary[];
	if (account.provider === 'gmail') {
		const threadId = await withMailbox(account, locator.path, async (client) => {
			const message = await client.fetchOne(String(locator.uid), { threadId: true }, { uid: true });
			return message ? message.threadId : undefined;
		});
		const paths = await rolePaths(account, ['archive', 'sent', 'inbox']);
		found = threadId ? await searchFolders(account, paths, [{ threadId }]) : [];
	} else {
		const criteria = conversationCriteria([detail]);
		found = await searchFolders(account, await rolePaths(account, THREAD_ROLES), criteria);
	}
	// Later folders win: a Gmail message in Inbox is addressed there rather than in All Mail.
	const unique = new Map(found.map((summary) => [summary.messageId ?? summary.ref, summary]));
	return [...unique.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/** Bytes read from the start of a body part for a list preview. */
const PREVIEW_BYTES = { text: 4096, html: 16384 };

/** Previews of IMAP messages in one mailbox: only the start of each text part, never `\Seen`. */
async function imapPreviews(
	account: MailAccount,
	path: string,
	messages: MessageSummary[],
	previews: Map<string, string>
): Promise<void> {
	const byUid = new Map(
		messages.flatMap((m) => {
			const locator = imapLocator(decodeMessageRef(m.ref));
			return [[locator.uid, { summary: m, locator }] as const];
		})
	);
	await withMailbox(account, path, async (client, mailbox) => {
		const current = [...byUid.values()].filter(
			({ locator }) => locator.uidValidity === String(mailbox.uidValidity)
		);
		if (!current.length) return;
		const structures = await client.fetchAll(
			current.map(({ locator }) => locator.uid),
			{ uid: true, bodyStructure: true },
			{ uid: true }
		);
		const groups = new Map<string, { part: PreviewPart; uids: number[] }>();
		for (const message of structures) {
			const part = previewPart(message.bodyStructure);
			if (!part) continue;
			const key = JSON.stringify(part);
			const group = groups.get(key) ?? { part, uids: [] };
			group.uids.push(message.uid);
			groups.set(key, group);
		}
		for (const { part, uids } of groups.values()) {
			const maxLength = part.html ? PREVIEW_BYTES.html : PREVIEW_BYTES.text;
			const fetched = await client.fetchAll(
				uids,
				{ uid: true, bodyParts: [{ key: part.partId, start: 0, maxLength }] },
				{ uid: true }
			);
			for (const message of fetched) {
				const entry = byUid.get(message.uid);
				const content = message.bodyParts && [...message.bodyParts.values()][0];
				if (!entry || !content) continue;
				const binary = message.binaryParts?.size ? { ...part, encoding: '8bit' } : part;
				const text = decodePartStart(content, binary);
				const body = bodyText({
					html: part.html ? text : null,
					text: part.html ? '' : text,
					subject: entry.summary.subject
				});
				previews.set(entry.summary.ref, previewOf(body));
			}
		}
	});
}

/**
 * One-line previews of listed messages by ref: the new text without quotes, from the start of
 * the body (IMAP) or Exchange's own preview. Messages that are gone have none.
 */
export async function messagePreviews(
	account: MailAccount,
	messages: MessageSummary[]
): Promise<Map<string, string>> {
	const previews = new Map<string, string>();
	if (!messages.length) return previews;
	if (account.provider === 'exchange') {
		const found = await ews.previews(
			account,
			messages.map((m) => ({
				itemId: ewsLocator(decodeMessageRef(m.ref)).itemId,
				subject: m.subject
			}))
		);
		messages.forEach((m, index) => {
			const preview = found[index];
			if (preview !== null) previews.set(m.ref, preview);
		});
		return previews;
	}
	const byPath = new Map<string, MessageSummary[]>();
	for (const message of messages) {
		const { path } = imapLocator(decodeMessageRef(message.ref));
		byPath.set(path, [...(byPath.get(path) ?? []), message]);
	}
	for (const [path, list] of byPath) await imapPreviews(account, path, list, previews);
	return previews;
}

/**
 * Finds a message by its Message-ID header after it moved without this app (in another mail
 * program, or by a server rule): its last folder first, then the other folders, Drafts and Sent
 * last. Null when it is in none of them.
 */
export async function findMessage(
	account: MailAccount,
	messageId: string,
	lastPath: string
): Promise<string | null> {
	const folders = await getFolders(account);
	// Drafts and Sent last: the Sent copy of a message sent to oneself shares its Message-ID.
	const late = (f: { role: string | null }) => f.role === 'drafts' || f.role === 'sent';
	const others = [...folders.filter((f) => !late(f)), ...folders.filter(late)];
	const paths = [lastPath, ...others.map((f) => f.path).filter((path) => path !== lastPath)];
	for (const path of paths) {
		if (account.provider === 'exchange') {
			const itemId = await ews.findByMessageId(account, path, messageId).catch(() => null);
			if (itemId) return encodeMessageRef({ kind: 'ews', accountId: account.id, path, itemId });
			continue;
		}
		const found = await withMailbox(account, path, async (client, mailbox) => {
			const uids = await searchUids(client, account, { header: { 'message-id': messageId } });
			return uids.length
				? { uid: Math.max(...uids), uidValidity: String(mailbox.uidValidity) }
				: null;
		}).catch(() => null);
		if (found) return encodeMessageRef({ kind: 'imap', accountId: account.id, path, ...found });
	}
	return null;
}
