import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
	ACCESS_LEVEL_LABELS,
	INVITATION_RESPONSES,
	LIST_FILTERS,
	type Address,
	type Invitation,
	type MessageSummary
} from '../../mail-types';
import {
	loadDraft,
	prepareForward,
	prepareReply,
	respondToInvitation,
	saveDraft,
	sendDraft,
	type Draft,
	type OutgoingAttachment
} from '../mail/compose';
import { parseAddressList } from '../mail/addresses';
import { groupConversations, type Conversation } from '../mail/conversations';
import { errorMessage, MailError } from '../mail/errors';
import { getFolders, resolveFolder } from '../mail/folders';
import { decodeMessageRef, InvalidMessageRefError } from '../mail/message-ref';
import {
	conversationMembers,
	findMessage,
	getAttachment,
	getMessage,
	getThread,
	groupRefs,
	listMessages,
	messagePreviews,
	moveMessages,
	setFlags,
	type MessageFilters
} from '../mail/messages';
import { textToComposeHtml } from '../mail/html-body';
import { baseSubject, composeBody, formatAddress, looksLikeReplySubject } from '../mail/threading';
import type { MailAccount } from '../mail/types';
import { McpAccess, McpAccessError } from './access';
import { McpRefs } from './refs';

const INSTRUCTIONS = `Email server for the user's mail accounts (Gmail, Purelymail, Microsoft 365,
Exchange). Only the accounts this connection was granted are visible; call list_accounts first.
Accounts may limit this connection to recent messages or withhold attachments; list_accounts
shows the limits.

Messages are addressed by a short message_ref returned from list_messages, search_messages,
get_message and get_thread. Pass it back unchanged. It stays valid when the message is moved,
archived or trashed.

To review a mailbox: list_messages with group_by "thread" returns one entry per conversation with
a preview of its latest message and last_from_me (true when the user sent the last message, so
nothing is waiting for them). get_thread then returns the whole conversation in one call, each
message with only its new text. get_message is for a single message with headers, attachments and
the full quoted body.

Results leave out default values: boolean fields (unread, starred, draft, has_attachments,
last_from_me, quoted_removed) appear only when true, "account" only when results span several
accounts, and "to" in lists only when the recipients are not just the account itself.

To respond to an existing email ALWAYS call reply_to_message (or forward_message) with its
message_ref. These tools set In-Reply-To, References, the "Re:" subject, the recipients and the
quoted original, so the reply stays in the same conversation. Never use compose_new_message for a
reply. compose_new_message is only for starting a brand-new conversation.

Every sending tool takes mode "draft" or "send". Use "draft" unless the user explicitly asked to
send; drafts appear in the account's Drafts folder for the user to review, and send_draft sends
one later. Reading a message never marks it as read.

Calendar invitations appear as "invitation" in get_message. Answer one with respond_to_invitation
only when the user asked to; it sends the answer to the organizer immediately.`;

function json(value: unknown): CallToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(message: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text: message }] };
}

async function guard(fn: () => Promise<CallToolResult | unknown>): Promise<CallToolResult> {
	try {
		const result = await fn();
		return result && typeof result === 'object' && 'content' in result
			? (result as CallToolResult)
			: json(result);
	} catch (error) {
		if (
			error instanceof McpAccessError ||
			error instanceof MailError ||
			error instanceof InvalidMessageRefError
		) {
			return failure(error.message);
		}
		console.error('[mcp] tool failed', error);
		return failure('Internal error. Try again later.');
	}
}

const addressText = (a: Address | null) => (a ? formatAddress(a) : null);

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Flags that are set; unset ones are left out. */
function flagsOut(message: MessageSummary) {
	return {
		...(message.unread && { unread: true }),
		...(message.starred && { starred: true }),
		...(message.draft && { draft: true }),
		...(message.hasAttachments && { has_attachments: true })
	};
}

function invitationOut(invitation: Invitation) {
	return {
		method: invitation.method,
		title: invitation.title,
		start: invitation.start,
		end: invitation.end,
		all_day: invitation.allDay,
		location: invitation.location,
		organizer: addressText(invitation.organizer),
		recurring: invitation.recurring,
		your_status: invitation.ownStatus,
		attendees: invitation.attendees.map((a) => ({ address: formatAddress(a), status: a.status }))
	};
}

const MAX_BODY_CHARS = 100_000;
const MAX_THREAD_BODY_CHARS = 20_000;
const MAX_THREAD_MESSAGES = 30;
const MAX_PARTICIPANTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const messageRef = z.string().min(1).describe('A message_ref from a listing tool.');
const accountRef = z.string().min(1).describe('Account ID or email address from list_accounts.');
const recipientList = z
	.array(z.string().trim().min(3))
	.max(100)
	.describe('Email addresses, optionally as "Name <address>".');
const mode = z
	.enum(['draft', 'send'])
	.default('draft')
	.describe('"draft" saves to Drafts for review (default); "send" sends immediately.');
const attachmentInput = z
	.array(
		z.object({
			filename: z.string().min(1).max(255),
			mime_type: z.string().min(1).default('application/octet-stream'),
			content_base64: z.string().min(1)
		})
	)
	.max(20)
	.optional()
	.describe('Files to attach.');
const groupBy = z
	.enum(['message', 'thread'])
	.default('message')
	.describe(
		'"thread" returns one entry per conversation (with last_from_me from the Sent folder) instead of one per message.'
	);
const includePreview = z
	.boolean()
	.default(true)
	.describe(
		"A one-line preview of each message's new text, without quotes (up to 200 characters)."
	);

function attachmentsFrom(input: z.infer<typeof attachmentInput>): OutgoingAttachment[] {
	return (input ?? []).map((a) => ({
		filename: a.filename,
		contentType: a.mime_type,
		content: Buffer.from(a.content_base64, 'base64')
	}));
}

/** The AI's plain text as HTML above the signature and quote. */
function withBody(body: string, suffix: string): string {
	return textToComposeHtml(body) + suffix;
}

/** A body for AI clients: the new text only, unless quotes were asked for, and capped. */
function bodyOut(
	read: { detail: { text: string }; newText: string | null },
	includeQuoted: boolean,
	limit: number
) {
	const quotedRemoved = !includeQuoted && read.newText !== null;
	const body = quotedRemoved ? read.newText! : read.detail.text;
	const truncated = body.length > limit;
	return {
		body: truncated ? body.slice(0, limit) : body,
		...(quotedRemoved && { quoted_removed: true }),
		...(truncated && { body_truncated: true })
	};
}

/** One server per request, holding the client's grants for that request. */
export function createMcpServer(
	userId: string,
	access: McpAccess,
	refs: McpRefs = new McpRefs(userId)
): McpServer {
	const server = new McpServer(
		{ name: 'webmail', version: '1.0.0' },
		{ instructions: INSTRUCTIONS }
	);
	const accountsById = new Map(access.list().map((g) => [g.account.id, g.account]));
	const accountEmail = (id: string) => accountsById.get(id)?.email ?? id;

	/**
	 * Runs `fn` with the mail-layer ref of a short ref. A message that moved without these tools is
	 * looked up again by its Message-ID, and the short ref follows it.
	 */
	async function withMessage<T>(shortRef: string, fn: (ref: string) => Promise<T>): Promise<T> {
		const row = await refs.resolve(shortRef);
		try {
			return await fn(row.locator);
		} catch (error) {
			const account = accountsById.get(row.accountId);
			const gone = error instanceof MailError && (error.status === 404 || error.status === 409);
			if (!gone || !account || !row.messageId) throw error;
			const found = await findMessage(account, row.messageId, decodeMessageRef(row.locator).path);
			if (!found || found === row.locator) throw error;
			await refs.moved(new Map([[row.locator, found]]));
			return fn(found);
		}
	}

	async function shortRefOf(ref: string, accountId: string, messageId: string | null) {
		return (await refs.shorten([{ ref, accountId, messageId }])).get(ref)!;
	}

	async function deliver(
		draft: Draft,
		how: 'draft' | 'send',
		options: { answersRef?: string; replacesDraftRef?: string } = {}
	) {
		const account = accountsById.get(draft.accountId)!;
		const recipients = {
			from: formatAddress({ name: account.displayName, address: account.email }),
			to: draft.to.map(formatAddress),
			cc: draft.cc.map(formatAddress),
			bcc: draft.bcc.map(formatAddress),
			subject: draft.subject,
			in_reply_to: draft.inReplyTo
		};
		if (how === 'draft') {
			const ref = await saveDraft(userId, draft, options.replacesDraftRef);
			return {
				status: 'draft_saved',
				draft_ref: await shortRefOf(ref, draft.accountId, null),
				...recipients
			};
		}
		const result = await sendDraft(userId, draft, options);
		return { status: 'sent', message_id: result.messageId, ...recipients };
	}

	server.registerTool(
		'list_accounts',
		{
			title: 'List mail accounts',
			description: 'Lists the mail accounts this connection may use and its access level for each.',
			annotations: { readOnlyHint: true }
		},
		() =>
			guard(async () =>
				access.list().map(({ account, level, maxAgeDays, allowAttachments }) => ({
					account_id: account.id,
					email: account.email,
					label: account.label,
					provider: account.provider,
					access: level,
					access_description: ACCESS_LEVEL_LABELS[level],
					max_age_days: maxAgeDays,
					attachments_allowed: allowAttachments
				}))
			)
	);

	server.registerTool(
		'list_folders',
		{
			title: 'List folders',
			description:
				"Lists an account's folders. Standard folders have a role (inbox, drafts, sent, archive, spam, trash) usable as the folder argument elsewhere.",
			inputSchema: z.object({ account: accountRef }),
			annotations: { readOnlyHint: true }
		},
		({ account }) =>
			guard(async () =>
				(await getFolders(access.require(account, 'read'))).map((f) => ({
					path: f.path,
					role: f.role
				}))
			)
	);

	const folderArg = z
		.string()
		.min(1)
		.default('inbox')
		.describe('A role (inbox, drafts, sent, archive, spam, trash) or a folder path.');

	/**
	 * The other messages of the conversations on a page, from the same sources as get_thread, so
	 * counts and the last sender agree with it. Messages outside the time window are left out.
	 */
	async function relatedMessages(
		accounts: MailAccount[],
		listed: MessageSummary[]
	): Promise<{ messages: MessageSummary[]; errors: { accountId: string; message: string }[] }> {
		const found: MessageSummary[] = [];
		const errors: { accountId: string; message: string }[] = [];
		await Promise.all(
			accounts.map(async (account) => {
				const own = listed.filter((m) => m.accountId === account.id);
				if (!own.length) return;
				try {
					found.push(...access.visible(await conversationMembers(account, own)));
				} catch (error) {
					errors.push({
						accountId: account.id,
						message: `Conversations incomplete: ${errorMessage(error)}`
					});
				}
			})
		);
		return { messages: found, errors };
	}

	/** Previews by mail-layer ref; an account whose previews fail just has none. */
	async function previewsOf(messages: MessageSummary[]): Promise<Map<string, string>> {
		const byAccount = new Map<string, MessageSummary[]>();
		for (const m of messages)
			byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);
		const maps = await Promise.all(
			[...byAccount].map(([accountId, list]) =>
				messagePreviews(accountsById.get(accountId)!, list).catch((error) => {
					console.error('[mcp] previews failed', error);
					return new Map<string, string>();
				})
			)
		);
		return new Map(maps.flatMap((map) => [...map]));
	}

	/** Recipients unless they are just the account itself. */
	function recipientsOut(message: MessageSummary) {
		const own = accountsById.get(message.accountId)?.email ?? '';
		const onlyOwn = message.to.length === 1 && sameAddress(message.to[0].address, own);
		return onlyOwn ? {} : { to: message.to.map(formatAddress) };
	}

	function conversationOut(
		conversation: Conversation,
		short: Map<string, string>,
		previews: Map<string, string> | null,
		multiAccount: boolean
	) {
		const last = conversation.messages.at(-1)!;
		const newest = conversation.listed[0];
		const own = accountsById.get(newest.accountId)?.email ?? '';
		const people = new Map<string, string>();
		for (const m of conversation.messages) {
			for (const a of [...(m.from ? [m.from] : []), ...m.to]) {
				const key = a.address.toLowerCase();
				if (!sameAddress(a.address, own) && !people.has(key)) people.set(key, a.name || a.address);
			}
		}
		const participants = [...people.values()];
		const unread = conversation.listed.filter((m) => m.unread).length;
		const preview = previews?.get(last.ref);
		return {
			subject: baseSubject(newest.subject),
			...(multiAccount && { account: accountEmail(newest.accountId) }),
			participants:
				participants.length > MAX_PARTICIPANTS
					? [
							...participants.slice(0, MAX_PARTICIPANTS),
							`+${participants.length - MAX_PARTICIPANTS} more`
						]
					: participants,
			message_count: conversation.messages.length,
			...(unread && { unread_count: unread }),
			last_date: last.date,
			last_from: addressText(last.from),
			...(last.from && sameAddress(last.from.address, own) && { last_from_me: true }),
			...(conversation.listed.some((m) => m.hasAttachments) && { has_attachments: true }),
			message_refs: conversation.listed.map((m) => short.get(m.ref)!),
			...(preview !== undefined && { preview })
		};
	}

	async function listOrSearch(
		account: string | undefined,
		folder: string,
		filters: MessageFilters,
		options: {
			limit: number;
			cursor: string | undefined;
			groupBy: 'message' | 'thread';
			includePreview: boolean;
		}
	) {
		const accounts = account ? [access.require(account, 'read')] : access.accounts('read');
		if (!accounts.length)
			throw new McpAccessError(
				'This connection has no mail accounts. The user can grant some at Settings → Connected apps in the webmail.'
			);
		const threads = options.groupBy === 'thread';
		const page = await listMessages(
			accounts,
			folder,
			filters,
			options.cursor ?? null,
			options.limit,
			{
				notBefore: access.notBefore(accounts),
				threads
			}
		);
		const errors = [...page.errors];
		const multiAccount = accounts.length > 1;

		let conversations: Conversation[] | null = null;
		if (threads) {
			const related = await relatedMessages(accounts, page.messages);
			errors.push(...related.errors);
			conversations = groupConversations(page.messages, related.messages);
		}
		const previewed = conversations ? conversations.map((c) => c.messages.at(-1)!) : page.messages;
		const previews = options.includePreview ? await previewsOf(previewed) : null;
		const shown = conversations ? conversations.flatMap((c) => c.listed) : page.messages;
		const short = await refs.shorten(shown);

		const result = conversations
			? { threads: conversations.map((c) => conversationOut(c, short, previews, multiAccount)) }
			: {
					messages: page.messages.map((m) => {
						const preview = previews?.get(m.ref);
						return {
							message_ref: short.get(m.ref)!,
							...(multiAccount && { account: accountEmail(m.accountId) }),
							from: addressText(m.from),
							...recipientsOut(m),
							subject: m.subject,
							date: m.date,
							...flagsOut(m),
							...(preview !== undefined && { preview })
						};
					})
				};
		return {
			...result,
			next_cursor: page.nextCursor,
			...(errors.length && {
				errors: errors.map((e) => ({ account: accountEmail(e.accountId), error: e.message }))
			})
		};
	}

	const listOptions = {
		group_by: groupBy,
		include_preview: includePreview,
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.default(25)
			.describe('Messages per page; with group_by "thread" they are grouped after paging.'),
		cursor: z.string().optional().describe('next_cursor from the previous page.')
	};

	server.registerTool(
		'list_messages',
		{
			title: 'List messages',
			description:
				'Lists messages in a folder, newest first. Omit account to list all granted accounts merged by date. ' +
				'Parameters beyond the folder: group_by "thread" (default "message") returns one entry per ' +
				'conversation with participants, message_count and unread_count, the last sender and last_from_me ' +
				'(true when the user sent the last message, from all folders including Sent), and the message_refs ' +
				'of its messages in this folder; message_count matches get_thread. include_preview (default true) ' +
				'adds a one-line preview of each message\'s new text without quotes (with group_by "thread", of ' +
				'the latest message); set it to false for shorter results. limit (default 25, up to 100) counts ' +
				'messages, cursor continues with next_cursor.',
			inputSchema: z.object({
				account: accountRef.optional(),
				folder: folderArg,
				filter: z.enum(LIST_FILTERS).default('all'),
				...listOptions
			}),
			annotations: { readOnlyHint: true }
		},
		({ account, folder, filter, limit, cursor, group_by, include_preview }) =>
			guard(() =>
				listOrSearch(
					account,
					folder,
					{ filter },
					{ limit, cursor, groupBy: group_by, includePreview: include_preview }
				)
			)
	);

	server.registerTool(
		'search_messages',
		{
			title: 'Search messages',
			description:
				'Searches one folder (default inbox; use "archive" for Gmail All Mail) by text and fields, newest first. ' +
				'from, to, and subject match words anywhere in the field. For Gmail, query accepts Gmail search syntax. ' +
				'Takes the same group_by ("message" or "thread"), include_preview (default true), limit, and cursor ' +
				'parameters as list_messages and returns the same output.',
			inputSchema: z.object({
				query: z
					.string()
					.max(500)
					.optional()
					.describe('Free text matched against headers and body.'),
				from: z.string().max(200).optional(),
				to: z.string().max(200).optional(),
				subject: z.string().max(200).optional(),
				since: z.iso.date().optional().describe('YYYY-MM-DD, inclusive.'),
				before: z.iso.date().optional().describe('YYYY-MM-DD, exclusive.'),
				unread: z.boolean().optional(),
				starred: z.boolean().optional(),
				account: accountRef.optional(),
				folder: folderArg,
				...listOptions
			}),
			annotations: { readOnlyHint: true }
		},
		({ account, folder, limit, cursor, group_by, include_preview, since, before, ...filters }) =>
			guard(() =>
				listOrSearch(
					account,
					folder,
					{
						...filters,
						since: since ? new Date(since) : undefined,
						before: before ? new Date(before) : undefined
					},
					{ limit, cursor, groupBy: group_by, includePreview: include_preview }
				)
			)
	);

	server.registerTool(
		'get_message',
		{
			title: 'Read message',
			description:
				"Returns a message's headers, plain-text body, attachment list (unless the account withholds attachments), " +
				'and calendar invitation if it carries one. Does not mark it as read. ' +
				'Parameter include_quoted (default true): false returns only the new text of a reply, without the ' +
				'quoted earlier messages, and sets quoted_removed. For a whole conversation use get_thread instead.',
			inputSchema: z.object({
				message_ref: messageRef,
				include_quoted: z
					.boolean()
					.default(true)
					.describe(
						'false returns only the text above the first quoted message (quoted_removed is then true when something was cut).'
					)
			}),
			annotations: { readOnlyHint: true }
		},
		({ message_ref, include_quoted }) =>
			guard(async () => {
				const { grant, locator, read } = await withMessage(message_ref, (ref) =>
					access.requireMessage(ref, 'read')
				);
				const { detail } = read;
				// File names can be sensitive too, so a grant without attachments hides the list.
				const attachments = grant.allowAttachments
					? detail.attachments.length
						? {
								attachments: detail.attachments.map((a) => ({
									part_id: a.partId,
									filename: a.filename,
									content_type: a.contentType,
									size: a.size
								}))
							}
						: {}
					: { attachments_allowed: false };
				return {
					message_ref: await shortRefOf(detail.ref, detail.accountId, detail.messageId),
					account: accountEmail(detail.accountId),
					folder: locator.path,
					from: addressText(detail.from),
					to: detail.to.map(formatAddress),
					...(detail.cc.length && { cc: detail.cc.map(formatAddress) }),
					...(detail.replyTo.length && { reply_to: detail.replyTo.map(formatAddress) }),
					subject: detail.subject,
					date: detail.date,
					...flagsOut(detail),
					message_id: detail.messageId,
					...(detail.inReplyTo && { in_reply_to: detail.inReplyTo }),
					...attachments,
					...(detail.invitation && { invitation: invitationOut(detail.invitation) }),
					...bodyOut(read, include_quoted, MAX_BODY_CHARS)
				};
			})
	);

	server.registerTool(
		'get_thread',
		{
			title: 'Get conversation',
			description:
				'Returns the whole conversation a message belongs to (received and sent, all folders), oldest first, ' +
				'with its message_count; ' +
				"each message with its body. By default each body is only that message's new text, since the earlier " +
				"messages are listed too. Messages outside the account's time window are left out; long conversations " +
				'return the newest 30.',
			inputSchema: z.object({
				message_ref: messageRef,
				include_quoted: z
					.boolean()
					.default(false)
					.describe('true returns each full body including the quoted earlier messages.')
			}),
			annotations: { readOnlyHint: true }
		},
		({ message_ref, include_quoted }) =>
			guard(async () => {
				const { account, locator, read } = await withMessage(message_ref, (ref) =>
					access.requireMessage(ref, 'read')
				);
				const found = access.visible(await getThread(account, locator, read.detail));
				const thread = found.length ? found : [read.detail];
				const shown = thread.slice(-MAX_THREAD_MESSAGES);
				const reads = await Promise.allSettled(
					shown.map((m) => getMessage(account, decodeMessageRef(m.ref)))
				);
				const short = await refs.shorten(shown);
				const own = account.email;
				return {
					subject: baseSubject(read.detail.subject),
					message_count: thread.length,
					...(thread.length > shown.length && {
						earlier_messages_omitted: thread.length - shown.length
					}),
					messages: shown.flatMap((m, index) => {
						const result = reads[index];
						if (result.status === 'rejected') return [];
						const { detail } = result.value;
						return [
							{
								message_ref: short.get(m.ref)!,
								folder: decodeMessageRef(m.ref).path,
								from: addressText(detail.from),
								...(detail.from && sameAddress(detail.from.address, own) && { from_me: true }),
								to: detail.to.map(formatAddress),
								...(detail.cc.length && { cc: detail.cc.map(formatAddress) }),
								date: detail.date,
								...flagsOut(m),
								...bodyOut(result.value, include_quoted, MAX_THREAD_BODY_CHARS)
							}
						];
					})
				};
			})
	);

	server.registerTool(
		'get_attachment',
		{
			title: 'Get attachment',
			description:
				'Returns one attachment: text files as text, images as images, other files as base64 (up to 10 MB).',
			inputSchema: z.object({ message_ref: messageRef, part_id: z.string().min(1) }),
			annotations: { readOnlyHint: true }
		},
		({ message_ref, part_id }) =>
			guard(async (): Promise<CallToolResult> => {
				const file = await withMessage(message_ref, async (ref) => {
					const { account, locator } = await access.requireMessage(ref, 'read', {
						attachments: true
					});
					return getAttachment(account, locator, part_id);
				});
				if (file.content.length > MAX_ATTACHMENT_BYTES) {
					return failure(`${file.filename} is larger than 10 MB and cannot be returned.`);
				}
				const type = file.contentType.split(';')[0].trim().toLowerCase();
				if (type.startsWith('text/') || /json|xml|csv|calendar/.test(type)) {
					return { content: [{ type: 'text', text: file.content.toString('utf8') }] };
				}
				if (type.startsWith('image/')) {
					return {
						content: [{ type: 'image', data: file.content.toString('base64'), mimeType: type }]
					};
				}
				return {
					content: [
						{
							type: 'resource',
							resource: {
								uri: `attachment:///${encodeURIComponent(file.filename)}`,
								mimeType: type,
								blob: file.content.toString('base64')
							}
						}
					]
				};
			})
	);

	server.registerTool(
		'update_messages',
		{
			title: 'Update messages',
			description:
				'Marks messages read/unread or starred/unstarred, or moves them to archive, trash, spam, inbox, or a folder. ' +
				'Their message_refs stay valid after moving.',
			inputSchema: z.object({
				message_refs: z.array(messageRef).min(1).max(200),
				action: z.enum([
					'mark_read',
					'mark_unread',
					'star',
					'unstar',
					'archive',
					'trash',
					'spam',
					'move_to_inbox',
					'move'
				]),
				folder: z.string().optional().describe('Destination path, required for "move".')
			}),
			annotations: { destructiveHint: false }
		},
		({ message_refs, action, folder }) =>
			guard(async () => {
				const locators = (await refs.resolveAll(message_refs)).map((row) => row.locator);
				await access.requireMessages(locators, 'organize');
				const groups = await groupRefs(userId, locators);
				switch (action) {
					case 'mark_read':
					case 'mark_unread':
						await setFlags(groups, { seen: action === 'mark_read' });
						break;
					case 'star':
					case 'unstar':
						await setFlags(groups, { flagged: action === 'star' });
						break;
					case 'move':
						if (!folder) throw new MailError('"folder" is required for move.', 400);
						await refs.moved(await moveMessages(groups, { path: folder }));
						break;
					case 'move_to_inbox':
						await refs.moved(await moveMessages(groups, 'inbox'));
						break;
					default:
						await refs.moved(await moveMessages(groups, action));
				}
				return { status: 'ok', updated: message_refs.length };
			})
	);

	server.registerTool(
		'reply_to_message',
		{
			title: 'Reply to message',
			description:
				'Replies in the same conversation as the given message. Sets In-Reply-To, References, the "Re:" subject, ' +
				'the recipients (sender, or everyone with reply_all), the signature, and the quoted original. ' +
				'Always use this, never compose_new_message, to answer an email.',
			inputSchema: z.object({
				message_ref: messageRef,
				body: z
					.string()
					.min(1)
					.describe(
						'Your reply as plain text only; it is sent as HTML with the signature and the quote added automatically.'
					),
				reply_all: z.boolean().default(false),
				extra_cc: recipientList.optional(),
				attachments: attachmentInput,
				mode
			})
		},
		({ message_ref, body, reply_all, extra_cc, attachments, mode: how }) =>
			guard(() =>
				withMessage(message_ref, async (ref) => {
					await access.requireMessage(ref, how === 'send' ? 'send' : 'organize');
					const prepared = await prepareReply(userId, ref, reply_all);
					const draft: Draft = {
						...prepared.draft,
						cc: [...prepared.draft.cc, ...parseAddressList(extra_cc ?? [])],
						html: withBody(body, prepared.suffix),
						attachments: attachmentsFrom(attachments)
					};
					return deliver(draft, how, { answersRef: ref });
				})
			)
	);

	server.registerTool(
		'forward_message',
		{
			title: 'Forward message',
			description:
				'Forwards a message with its original headers, text, and (by default) attachments under a "Fwd:" subject. ' +
				'Accounts that withhold attachments need include_attachments set to false.',
			inputSchema: z.object({
				message_ref: messageRef,
				to: recipientList.min(1),
				cc: recipientList.optional(),
				body: z.string().default('').describe('A plain-text note above the forwarded message.'),
				include_attachments: z.boolean().default(true),
				mode
			})
		},
		({ message_ref, to, cc, body, include_attachments, mode: how }) =>
			guard(() =>
				withMessage(message_ref, async (ref) => {
					await access.requireMessage(ref, how === 'send' ? 'send' : 'organize', {
						attachments: include_attachments,
						attachmentsHint: 'Forward with include_attachments set to false instead.'
					});
					const prepared = await prepareForward(userId, ref, include_attachments);
					const draft: Draft = {
						...prepared.draft,
						to: parseAddressList(to),
						cc: parseAddressList(cc ?? []),
						html: withBody(body, prepared.suffix)
					};
					return deliver(draft, how);
				})
			)
	);

	server.registerTool(
		'compose_new_message',
		{
			title: 'Compose new message',
			description:
				'Starts a brand-new conversation. Only for new emails: to answer an existing email use reply_to_message, ' +
				'which keeps the conversation together.',
			inputSchema: z.object({
				account: accountRef,
				to: recipientList.min(1),
				cc: recipientList.optional(),
				bcc: recipientList.optional(),
				subject: z.string().min(1).max(998),
				body: z
					.string()
					.min(1)
					.describe('Plain text; it is sent as HTML with the account signature added.'),
				attachments: attachmentInput,
				mode
			})
		},
		({ account: accountArg, to, cc, bcc, subject, body, attachments, mode: how }) =>
			guard(async () => {
				const account = access.require(accountArg, how === 'send' ? 'send' : 'organize');
				if (looksLikeReplySubject(subject)) {
					throw new MailError(
						'This subject looks like a reply. To answer an existing email, find it with list_messages or ' +
							'search_messages and call reply_to_message with its message_ref so the conversation stays together.',
						400
					);
				}
				const draft: Draft = {
					accountId: account.id,
					to: parseAddressList(to),
					cc: parseAddressList(cc ?? []),
					bcc: parseAddressList(bcc ?? []),
					subject,
					html: composeBody(textToComposeHtml(body), account.signature),
					inReplyTo: null,
					references: [],
					attachments: attachmentsFrom(attachments)
				};
				return deliver(draft, how);
			})
	);

	server.registerTool(
		'respond_to_invitation',
		{
			title: 'Respond to invitation',
			description:
				'Accepts, tentatively accepts, or declines the calendar invitation in a message (get_message shows it ' +
				'with method "request"). Sends the answer to the organizer immediately; there is no draft mode. ' +
				'Only use it when the user asked to answer the invitation.',
			inputSchema: z.object({
				message_ref: messageRef,
				response: z.enum(INVITATION_RESPONSES)
			})
		},
		({ message_ref, response }) =>
			guard(async () => {
				const result = await withMessage(message_ref, async (ref) => {
					await access.requireMessage(ref, 'send');
					return respondToInvitation(userId, ref, response);
				});
				return {
					status: 'sent',
					response,
					to: result.to.map(formatAddress),
					subject: result.subject
				};
			})
	);

	server.registerTool(
		'send_draft',
		{
			title: 'Send draft',
			description:
				'Sends a draft from the Drafts folder (for example one saved earlier with mode "draft"), keeping its reply headers.',
			inputSchema: z.object({
				draft_ref: messageRef.describe('A draft_ref or message_ref of a draft.')
			})
		},
		({ draft_ref }) =>
			guard(() =>
				withMessage(draft_ref, async (ref) => {
					const { account, locator } = await access.requireMessage(ref, 'send');
					if (locator.path !== (await resolveFolder(account, 'drafts'))) {
						throw new MailError('That message is not in the Drafts folder.', 400);
					}
					const draft = await loadDraft(userId, ref);
					return deliver(draft, 'send', { replacesDraftRef: ref });
				})
			)
	);

	return server;
}
