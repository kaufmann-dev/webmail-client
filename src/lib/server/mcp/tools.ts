import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
	ACCESS_LEVEL_LABELS,
	LIST_FILTERS,
	type Address,
	type MessageSummary
} from '../../mail-types';
import {
	loadDraft,
	prepareForward,
	prepareReply,
	saveDraft,
	sendDraft,
	type Draft,
	type OutgoingAttachment
} from '../mail/compose';
import { parseAddressList } from '../mail/addresses';
import { MailError } from '../mail/errors';
import { getFolders, resolveFolder } from '../mail/folders';
import { InvalidMessageRefError } from '../mail/message-ref';
import {
	getAttachment,
	getMessage,
	getThread,
	groupRefs,
	listMessages,
	moveMessages,
	setFlags,
	type MessageFilters
} from '../mail/messages';
import { composeBody, formatAddress, looksLikeReplySubject } from '../mail/threading';
import type { MailAccount } from '../mail/types';
import { McpAccess, McpAccessError } from './access';

const INSTRUCTIONS = `Email server for the user's mail accounts (Gmail, Purelymail, Microsoft 365).
Only the accounts this connection was granted are visible; call list_accounts first.

Messages are addressed by an opaque message_ref returned from list_messages, search_messages,
get_message and get_thread. Pass it back unchanged.

To respond to an existing email ALWAYS call reply_to_message (or forward_message) with its
message_ref. These tools set In-Reply-To, References, the "Re:" subject, the recipients and the
quoted original, so the reply stays in the same conversation. Never use compose_new_message for a
reply. compose_new_message is only for starting a brand-new conversation.

Every sending tool takes mode "draft" or "send". Use "draft" unless the user explicitly asked to
send; drafts appear in the account's Drafts folder for the user to review, and send_draft sends
one later. Reading a message never marks it as read.`;

function json(value: unknown): CallToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
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

function summaryOut(message: MessageSummary, accounts: Map<string, MailAccount>) {
	return {
		message_ref: message.ref,
		account: accounts.get(message.accountId)?.email ?? message.accountId,
		from: addressText(message.from),
		to: message.to.map(formatAddress),
		subject: message.subject,
		date: message.date,
		unread: message.unread,
		starred: message.starred,
		draft: message.draft,
		has_attachments: message.hasAttachments
	};
}

const MAX_BODY_CHARS = 100_000;
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

function attachmentsFrom(input: z.infer<typeof attachmentInput>): OutgoingAttachment[] {
	return (input ?? []).map((a) => ({
		filename: a.filename,
		contentType: a.mime_type,
		content: Buffer.from(a.content_base64, 'base64')
	}));
}

function withBody(body: string, suffix: string): string {
	return `${body.trimEnd()}\n\n${suffix}`;
}

/** One server per request, holding the client's grants for that request. */
export function createMcpServer(userId: string, access: McpAccess): McpServer {
	const server = new McpServer(
		{ name: 'webmail', version: '1.0.0' },
		{ instructions: INSTRUCTIONS }
	);
	const accountsById = new Map(access.list().map((g) => [g.account.id, g.account]));

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
			return { status: 'draft_saved', draft_ref: ref, ...recipients };
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
				access.list().map(({ account, level }) => ({
					account_id: account.id,
					email: account.email,
					label: account.label,
					provider: account.provider,
					access: level,
					access_description: ACCESS_LEVEL_LABELS[level]
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

	async function listOrSearch(
		account: string | undefined,
		folder: string,
		filters: MessageFilters,
		limit: number,
		cursor: string | undefined
	) {
		const accounts = account ? [access.require(account, 'read')] : access.accounts('read');
		if (!accounts.length)
			throw new McpAccessError(
				'This connection has no mail accounts. The user can grant some at Settings → Connected apps in the webmail.'
			);
		const page = await listMessages(accounts, folder, filters, cursor ?? null, limit);
		return {
			messages: page.messages.map((m) => summaryOut(m, accountsById)),
			next_cursor: page.nextCursor,
			errors: page.errors.map((e) => ({
				account: accountsById.get(e.accountId)?.email ?? e.accountId,
				error: e.message
			}))
		};
	}

	server.registerTool(
		'list_messages',
		{
			title: 'List messages',
			description:
				'Lists messages in a folder, newest first. Omit account to list all granted accounts merged by date.',
			inputSchema: z.object({
				account: accountRef.optional(),
				folder: folderArg,
				filter: z.enum(LIST_FILTERS).default('all'),
				limit: z.number().int().min(1).max(100).default(25),
				cursor: z.string().optional().describe('next_cursor from the previous page.')
			}),
			annotations: { readOnlyHint: true }
		},
		({ account, folder, filter, limit, cursor }) =>
			guard(() => listOrSearch(account, folder, { filter }, limit, cursor))
	);

	server.registerTool(
		'search_messages',
		{
			title: 'Search messages',
			description:
				'Searches one folder (default inbox; use "archive" for Gmail All Mail) by text and fields, newest first. ' +
				'For Gmail, query accepts Gmail search syntax.',
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
				limit: z.number().int().min(1).max(100).default(25),
				cursor: z.string().optional()
			}),
			annotations: { readOnlyHint: true }
		},
		({ account, folder, limit, cursor, since, before, ...filters }) =>
			guard(() =>
				listOrSearch(
					account,
					folder,
					{
						...filters,
						since: since ? new Date(since) : undefined,
						before: before ? new Date(before) : undefined
					},
					limit,
					cursor
				)
			)
	);

	server.registerTool(
		'get_message',
		{
			title: 'Read message',
			description:
				"Returns a message's headers, plain-text body, and attachment list. Does not mark it as read.",
			inputSchema: z.object({ message_ref: messageRef }),
			annotations: { readOnlyHint: true }
		},
		({ message_ref }) =>
			guard(async () => {
				const { account, locator } = access.requireRef(message_ref, 'read');
				const { detail } = await getMessage(account, locator);
				const truncated = detail.text.length > MAX_BODY_CHARS;
				return {
					...summaryOut(detail, accountsById),
					folder: locator.path,
					cc: detail.cc.map(formatAddress),
					reply_to: detail.replyTo.map(formatAddress),
					message_id: detail.messageId,
					in_reply_to: detail.inReplyTo,
					attachments: detail.attachments.map((a) => ({
						part_id: a.partId,
						filename: a.filename,
						content_type: a.contentType,
						size: a.size
					})),
					body: truncated ? detail.text.slice(0, MAX_BODY_CHARS) : detail.text,
					body_truncated: truncated
				};
			})
	);

	server.registerTool(
		'get_thread',
		{
			title: 'Get conversation',
			description:
				'Lists the other messages of the conversation a message belongs to (received and sent), oldest first.',
			inputSchema: z.object({ message_ref: messageRef }),
			annotations: { readOnlyHint: true }
		},
		({ message_ref }) =>
			guard(async () => {
				const { account, locator } = access.requireRef(message_ref, 'read');
				const { detail } = await getMessage(account, locator);
				const thread = await getThread(account, locator, detail);
				return thread.map((m) => summaryOut(m, accountsById));
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
				const { account, locator } = access.requireRef(message_ref, 'read');
				const file = await getAttachment(account, locator, part_id);
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
				'Marks messages read/unread or starred/unstarred, or moves them to archive, trash, spam, inbox, or a folder.',
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
				for (const ref of message_refs) access.requireRef(ref, 'organize');
				const groups = await groupRefs(userId, message_refs);
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
						await moveMessages(groups, { path: folder });
						break;
					case 'move_to_inbox':
						await moveMessages(groups, 'inbox');
						break;
					default:
						await moveMessages(groups, action);
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
				body: z.string().min(1).describe('Your reply text only; the quote is added automatically.'),
				reply_all: z.boolean().default(false),
				extra_cc: recipientList.optional(),
				attachments: attachmentInput,
				mode
			})
		},
		({ message_ref, body, reply_all, extra_cc, attachments, mode: how }) =>
			guard(async () => {
				access.requireRef(message_ref, how === 'send' ? 'send' : 'organize');
				const prepared = await prepareReply(userId, message_ref, reply_all);
				const draft: Draft = {
					...prepared.draft,
					cc: [...prepared.draft.cc, ...parseAddressList(extra_cc ?? [])],
					text: withBody(body, prepared.suffix),
					attachments: attachmentsFrom(attachments)
				};
				return deliver(draft, how, { answersRef: message_ref });
			})
	);

	server.registerTool(
		'forward_message',
		{
			title: 'Forward message',
			description:
				'Forwards a message with its original headers, text, and (by default) attachments under a "Fwd:" subject.',
			inputSchema: z.object({
				message_ref: messageRef,
				to: recipientList.min(1),
				cc: recipientList.optional(),
				body: z.string().default('').describe('A note above the forwarded message.'),
				include_attachments: z.boolean().default(true),
				mode
			})
		},
		({ message_ref, to, cc, body, include_attachments, mode: how }) =>
			guard(async () => {
				access.requireRef(message_ref, how === 'send' ? 'send' : 'organize');
				const prepared = await prepareForward(userId, message_ref, include_attachments);
				const draft: Draft = {
					...prepared.draft,
					to: parseAddressList(to),
					cc: parseAddressList(cc ?? []),
					text: withBody(body, prepared.suffix)
				};
				return deliver(draft, how);
			})
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
				body: z.string().min(1),
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
					text: composeBody(body, account.signature),
					inReplyTo: null,
					references: [],
					attachments: attachmentsFrom(attachments)
				};
				return deliver(draft, how);
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
			guard(async () => {
				const { account, locator } = access.requireRef(draft_ref, 'send');
				if (locator.path !== (await resolveFolder(account, 'drafts'))) {
					throw new MailError('That message is not in the Drafts folder.', 400);
				}
				const draft = await loadDraft(userId, draft_ref);
				return deliver(draft, 'send', { replacesDraftRef: draft_ref });
			})
	);

	return server;
}
