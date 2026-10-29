import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { detectMimeType } from 'nodemailer/lib/mime-funcs/mime-types';
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
	cancelMeeting,
	loadDraft,
	prepareForward,
	prepareReply,
	respondToInvitation,
	saveDraft,
	sendDraft,
	updateMeeting,
	type Draft,
	type OutgoingAttachment
} from '../mail/compose';
import { MCP_RESOURCE } from '../auth';
import { parseAddressList } from '../mail/addresses';
import { attachmentText } from '../mail/attachment-text';
import { findMeetingTimes } from '../mail/availability';
import { groupConversations, type Conversation } from '../mail/conversations';
import { errorMessage, MailError, MessageGoneError } from '../mail/errors';
import {
	createFolder,
	deleteFolder,
	getFolders,
	moveFolder,
	renameFolder,
	requireFolder,
	resolveFolder
} from '../mail/folders';
import { decodeMessageRef, InvalidMessageRefError } from '../mail/message-ref';
import {
	conversationMembers,
	findMessage,
	getAttachment,
	getAttachments,
	getMessage,
	getThread,
	groupRefs,
	listMessages,
	messagePreviews,
	moveMessages,
	receivedDates,
	setFlags,
	type MessageFilters
} from '../mail/messages';
import { textToComposeHtml } from '../mail/html-body';
import { baseSubject, composeBody, formatAddress, looksLikeReplySubject } from '../mail/threading';
import type { MailAccount } from '../mail/types';
import { McpAccess, McpAccessError } from './access';
import { McpRefs } from './refs';
import { MAX_UPLOAD_BYTES, transfers } from './transfers';
import { formatWallClock, isTimeZone, parseWallClock, zonedToUtc } from '../mail/time-zones';

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

Attachments: get_attachment returns readable content (text, images, and the text of PDF and
Office documents) and a short-lived download_url to save the file with curl. To attach a local
file, call create_attachment_upload, PUT the file to its upload_url, and pass {"upload_id"} in
attachments. A file that is already in a message is attached with {"message_ref", "part_id"},
without downloading it.

Calendar invitations appear as "invitation" in get_message. Answer one with respond_to_invitation
only when the user asked to; it sends the answer to the organizer immediately.

To plan a meeting, find_meeting_times (Exchange accounts only) returns the busy times of the user
and the attendees and the times that suit everyone. create_meeting invites attendees; like the
other sending tools it saves a draft unless the user asked to send. Exchange puts sent meetings in
the user's calendar; other accounts send the invitation by email only, so the user adds the
meeting to their own calendar. update_meeting and cancel_meeting change or cancel a meeting the
user sent, given the invitation in Sent Items; they notify the affected attendees immediately.`;

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
		...(invitation.organizedByYou && { organized_by_you: true }),
		attendees: invitation.attendees.map((a) => ({ address: formatAddress(a), status: a.status }))
	};
}

const MAX_BODY_CHARS = 100_000;
const MAX_THREAD_BODY_CHARS = 20_000;
const MAX_THREAD_MESSAGES = 30;
const MAX_PARTICIPANTS = 10;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_OUTGOING_BYTES = 25 * 1024 * 1024;

const messageRef = z.string().min(1).describe('A message_ref from a listing tool.');
const timeZone = z
	.string()
	.refine(isTimeZone, 'Unknown time zone.')
	.describe('IANA time zone of the given times, such as "Europe/Vienna".');
const wallClock = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
	.describe('Local date and time in time_zone, YYYY-MM-DDTHH:MM.');
const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.describe('YYYY-MM-DD in time_zone.');
const clockTime = z.string().regex(/^\d{2}:\d{2}$/);

/** An ISO instant from a local date and time in a time zone. */
function instantIn(value: string, zone: string): string {
	const time = parseWallClock(value);
	if (!time) throw new MailError(`Not a valid date and time: ${value}`, 400);
	return new Date(zonedToUtc(time, zone)).toISOString();
}
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
		z.union([
			z.object({
				upload_id: z.string().min(1).describe('From create_attachment_upload, after the PUT.')
			}),
			z.object({
				message_ref: messageRef,
				part_id: z.string().min(1).describe('An attachment part_id from get_message.')
			})
		])
	)
	.max(20)
	.optional()
	.describe(
		'Files to attach: uploaded files ({upload_id}) or attachments of other messages ({message_ref, part_id}).'
	);
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
	clientId: string,
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
			if (!(error instanceof MessageGoneError) || !account || !row.messageId) throw error;
			const found = await findMessage(account, row.messageId, decodeMessageRef(row.locator).path);
			if (!found || found === row.locator) throw error;
			await refs.moved(new Map([[row.locator, found]]));
			return fn(found);
		}
	}

	/**
	 * The mail-layer refs of short refs for a bulk action. Messages that moved without these tools
	 * are found again by their Message-ID; any that are gone fail the action.
	 */
	async function currentLocators(shortRefs: string[]): Promise<string[]> {
		const rows = await refs.resolveAll(shortRefs);
		const moves = new Map<string, string>();
		let missing = 0;
		for (const account of accountsById.values()) {
			const accountRows = rows.filter((row) => row.accountId === account.id);
			if (!accountRows.length) continue;
			const dates = await receivedDates(
				account,
				accountRows.map((row) => decodeMessageRef(row.locator))
			);
			for (const row of accountRows) {
				if (dates.has(row.locator)) continue;
				const { path } = decodeMessageRef(row.locator);
				const found = row.messageId ? await findMessage(account, row.messageId, path) : null;
				if (found && found !== row.locator) moves.set(row.locator, found);
				else missing++;
			}
		}
		if (moves.size) await refs.moved(moves);
		if (missing) {
			throw new MessageGoneError(
				missing === 1
					? 'One of these messages no longer exists.'
					: `${missing} of these messages no longer exist.`
			);
		}
		return rows.map((row) => moves.get(row.locator) ?? row.locator);
	}

	async function shortRefOf(ref: string, accountId: string, messageId: string | null) {
		return (await refs.shorten([{ ref, accountId, messageId }])).get(ref)!;
	}

	/**
	 * The files to attach, in order: uploads of this client, and attachments of messages the client
	 * may read with their attachments.
	 */
	async function resolveAttachments(
		input: z.infer<typeof attachmentInput>
	): Promise<{ files: OutgoingAttachment[]; uploadIds: string[] }> {
		const entries = input ?? [];
		const uploadIds = entries.flatMap((a) => ('upload_id' in a ? [a.upload_id] : []));
		const uploads = transfers.takeUploads({ userId, clientId }, uploadIds);
		const parts = new Map<string, string[]>();
		for (const a of entries) {
			if ('message_ref' in a)
				parts.set(a.message_ref, [...(parts.get(a.message_ref) ?? []), a.part_id]);
		}
		const fromMessages = new Map<string, OutgoingAttachment>();
		for (const [shortRef, partIds] of parts) {
			const files = await withMessage(shortRef, async (ref) => {
				const { account, locator } = await access.requireMessage(ref, 'read', {
					attachments: true
				});
				return getAttachments(account, locator, partIds);
			});
			partIds.forEach((partId, i) => fromMessages.set(`${shortRef} ${partId}`, files[i]));
		}
		let next = 0;
		const files = entries.map((a) =>
			'upload_id' in a ? uploads[next++] : fromMessages.get(`${a.message_ref} ${a.part_id}`)!
		);
		const total = files.reduce((sum, f) => sum + f.content.length, 0);
		if (total > MAX_OUTGOING_BYTES) {
			throw new MailError('Attachments larger than 25 MB in total cannot be sent.', 413);
		}
		return { files, uploadIds };
	}

	async function deliver(
		draft: Draft,
		how: 'draft' | 'send',
		options: { answersRef?: string; replacesDraftRef?: string; uploadIds?: string[] } = {}
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
			const { ref, messageId } = await saveDraft(userId, draft, options.replacesDraftRef);
			transfers.releaseUploads(options.uploadIds ?? []);
			return {
				status: 'draft_saved',
				draft_ref: await shortRefOf(ref, draft.accountId, messageId),
				...recipients
			};
		}
		const result = await sendDraft(userId, draft, options);
		transfers.releaseUploads(options.uploadIds ?? []);
		return {
			status: 'sent',
			message_id: result.messageId,
			...recipients,
			...(result.draftKept && { draft_kept: true })
		};
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
				"Lists an account's folders. Standard folders have a role (inbox, drafts, sent, archive, spam, trash) usable as the folder argument elsewhere. " +
				'create_folder, rename_folder, move_folder, and delete_folder manage the others.',
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

	const folderPath = z.string().min(1).describe('A folder path from list_folders.');
	const folderNameArg = z
		.string()
		.min(1)
		.max(100)
		.describe('The folder name alone, without "/" or the path of its parent.');

	server.registerTool(
		'create_folder',
		{
			title: 'Create folder',
			description:
				'Creates a folder at the top level of an account, or below parent. Returns its path.',
			inputSchema: z.object({
				account: accountRef,
				name: folderNameArg,
				parent: z
					.string()
					.min(1)
					.optional()
					.describe(
						'A role (such as inbox) or folder path to create it in; omit for the top level.'
					)
			}),
			annotations: { destructiveHint: false }
		},
		({ account: accountArg, name, parent }) =>
			guard(async () => {
				const account = access.require(accountArg, 'organize');
				const parentPath = parent ? await requireFolder(account, parent) : null;
				return { path: await createFolder(account, parentPath, name) };
			})
	);

	server.registerTool(
		'rename_folder',
		{
			title: 'Rename folder',
			description:
				'Renames a folder in place; its subfolders move along. Standard (role) folders cannot be renamed. ' +
				'Returns the new path. message_refs of the messages inside stay valid.',
			inputSchema: z.object({ account: accountRef, folder: folderPath, name: folderNameArg }),
			annotations: { destructiveHint: false, idempotentHint: false }
		},
		({ account: accountArg, folder, name }) =>
			guard(async () => {
				const account = access.require(accountArg, 'organize');
				const renamed = await renameFolder(account, folder, name);
				await refs.folderMoved(account.id, folder, renamed.path, renamed.delimiter);
				return { path: renamed.path };
			})
	);

	server.registerTool(
		'move_folder',
		{
			title: 'Move folder',
			description:
				'Moves a folder with its subfolders below parent, or to the top level when parent is omitted; its ' +
				'name stays. Standard (role) folders cannot be moved. Returns the new path. message_refs of the ' +
				'messages inside stay valid.',
			inputSchema: z.object({
				account: accountRef,
				folder: folderPath,
				parent: z
					.string()
					.min(1)
					.optional()
					.describe(
						'A role (such as inbox) or folder path to move it into; omit for the top level.'
					)
			}),
			annotations: { destructiveHint: false, idempotentHint: false }
		},
		({ account: accountArg, folder, parent }) =>
			guard(async () => {
				const account = access.require(accountArg, 'organize');
				const parentPath = parent ? await requireFolder(account, parent) : null;
				const moved = await moveFolder(account, folder, parentPath);
				await refs.folderMoved(account.id, folder, moved.path, moved.delimiter);
				return { path: moved.path };
			})
	);

	server.registerTool(
		'delete_folder',
		{
			title: 'Delete folder',
			description:
				'Deletes an empty folder with its empty subfolders. Standard (role) folders cannot be deleted, and a ' +
				'folder whose subtree still holds messages is refused: move or trash them with update_messages first.',
			inputSchema: z.object({ account: accountRef, folder: folderPath }),
			annotations: { destructiveHint: true }
		},
		({ account: accountArg, folder }) =>
			guard(async () => {
				await deleteFolder(access.require(accountArg, 'organize'), folder, { onlyEmpty: true });
				return { status: 'ok' };
			})
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
				'Returns the whole conversation a message belongs to, oldest first, with its message_count: ' +
				'received and sent, on Gmail and Exchange from every folder but Trash and Spam, elsewhere from ' +
				'Inbox, Sent, and Archive; the given message is always included. ' +
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
				const thread = access.visible(await getThread(account, locator, read.detail));
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
					messages: shown.map((m, index) => {
						const result = reads[index];
						const listed = {
							message_ref: short.get(m.ref)!,
							folder: decodeMessageRef(m.ref).path
						};
						if (result.status === 'rejected') {
							return {
								...listed,
								from: addressText(m.from),
								...(m.from && sameAddress(m.from.address, own) && { from_me: true }),
								to: m.to.map(formatAddress),
								date: m.date,
								...flagsOut(m),
								error: `Could not be read: ${errorMessage(result.reason)}`
							};
						}
						const { detail } = result.value;
						return {
							...listed,
							from: addressText(detail.from),
							...(detail.from && sameAddress(detail.from.address, own) && { from_me: true }),
							to: detail.to.map(formatAddress),
							...(detail.cc.length && { cc: detail.cc.map(formatAddress) }),
							date: detail.date,
							...flagsOut(m),
							...bodyOut(result.value, include_quoted, MAX_THREAD_BODY_CHARS)
						};
					})
				};
			})
	);

	server.registerTool(
		'get_attachment',
		{
			title: 'Get attachment',
			description:
				'Returns one attachment: its readable content (text files, images, and the text of PDF, Office, ' +
				'and OpenDocument files) and a download_url, valid for 15 minutes, to save the file itself ' +
				'with `curl -fo <filename> <download_url>`.',
			inputSchema: z.object({ message_ref: messageRef, part_id: z.string().min(1) }),
			annotations: { readOnlyHint: true }
		},
		({ message_ref, part_id }) =>
			guard(async (): Promise<CallToolResult> => {
				const { ref, file } = await withMessage(message_ref, async (ref) => {
					const { account, locator } = await access.requireMessage(ref, 'read', {
						attachments: true
					});
					return { ref, file: await getAttachment(account, locator, part_id) };
				});
				const download = transfers.createDownload({ userId, clientId, ref, partId: part_id });
				const type = file.contentType.split(';')[0].trim().toLowerCase();
				const info = {
					filename: file.filename,
					mime_type: type,
					size: file.content.length,
					download_url: `${MCP_RESOURCE}/files/${download.token}`,
					expires_at: new Date(download.expiresAt).toISOString()
				};
				if (type.startsWith('image/')) {
					return {
						content: [
							{ type: 'text', text: JSON.stringify(info) },
							...(file.content.length <= MAX_INLINE_IMAGE_BYTES
								? [
										{
											type: 'image' as const,
											data: file.content.toString('base64'),
											mimeType: type
										}
									]
								: [])
						]
					};
				}
				const text = await attachmentText(file);
				if (text === null) return json({ ...info, readable: false });
				if (text === '') {
					return json({
						...info,
						readable: false,
						hint: 'The document has no text layer; it is probably scanned. Download it and read its pages as images.'
					});
				}
				const truncated = text.length > MAX_BODY_CHARS;
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({ ...info, ...(truncated && { truncated: true }) })
						},
						{ type: 'text', text: truncated ? text.slice(0, MAX_BODY_CHARS) : text }
					]
				};
			})
	);

	server.registerTool(
		'create_attachment_upload',
		{
			title: 'Create attachment upload',
			description:
				'Creates an upload_url, valid for one hour, to send a local file as an attachment: upload it with ' +
				'`curl -fT <file> <upload_url>`, then pass {"upload_id"} in the attachments of ' +
				'compose_new_message, reply_to_message, or forward_message. Files are limited to 25 MB.',
			inputSchema: z.object({
				filename: z.string().trim().min(1).max(255).describe('The name recipients see.'),
				mime_type: z
					.string()
					.min(1)
					.optional()
					.describe('Defaults to the type of the file name extension.')
			})
		},
		({ filename, mime_type }) =>
			guard(async () => {
				if (!access.accounts('organize').length) {
					throw new McpAccessError(
						'No mail account allows this connection to write messages. The user can change this at ' +
							'Settings → Connected apps in the webmail.'
					);
				}
				const upload = transfers.createUpload(
					{ userId, clientId },
					{ filename, contentType: mime_type ?? detectMimeType(filename) }
				);
				return {
					upload_id: upload.uploadId,
					upload_url: `${MCP_RESOURCE}/uploads/${upload.uploadId}`,
					method: 'PUT',
					max_bytes: MAX_UPLOAD_BYTES,
					expires_at: new Date(upload.expiresAt).toISOString()
				};
			})
	);

	server.registerTool(
		'update_messages',
		{
			title: 'Update messages',
			description:
				'Marks messages read/unread or starred/unstarred, or moves them to archive, trash, spam, inbox, or a folder. ' +
				'On Gmail, archive removes the Inbox label; outside Inbox, Spam, and Trash the messages stay where they are. ' +
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
				const locators = await currentLocators(message_refs);
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
					const { files, uploadIds } = await resolveAttachments(attachments);
					const draft: Draft = {
						...prepared.draft,
						cc: [...prepared.draft.cc, ...parseAddressList(extra_cc ?? [])],
						html: withBody(body, prepared.suffix),
						attachments: files
					};
					return deliver(draft, how, { answersRef: ref, uploadIds });
				})
			)
	);

	server.registerTool(
		'forward_message',
		{
			title: 'Forward message',
			description:
				'Forwards a message with its original headers, text, and (by default) attachments under a "Fwd:" subject. ' +
				'Accounts that withhold attachments need include_attachments set to false. attachments adds further files.',
			inputSchema: z.object({
				message_ref: messageRef,
				to: recipientList.min(1),
				cc: recipientList.optional(),
				body: z.string().default('').describe('A plain-text note above the forwarded message.'),
				include_attachments: z.boolean().default(true),
				attachments: attachmentInput,
				mode
			})
		},
		({ message_ref, to, cc, body, include_attachments, attachments, mode: how }) =>
			guard(() =>
				withMessage(message_ref, async (ref) => {
					await access.requireMessage(ref, how === 'send' ? 'send' : 'organize', {
						attachments: include_attachments,
						attachmentsHint: 'Forward with include_attachments set to false instead.'
					});
					const prepared = await prepareForward(userId, ref, include_attachments);
					const { files, uploadIds } = await resolveAttachments(attachments);
					const draft: Draft = {
						...prepared.draft,
						to: parseAddressList(to),
						cc: parseAddressList(cc ?? []),
						html: withBody(body, prepared.suffix),
						attachments: [...prepared.draft.attachments, ...files]
					};
					return deliver(draft, how, { uploadIds });
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
				const { files, uploadIds } = await resolveAttachments(attachments);
				const draft: Draft = {
					accountId: account.id,
					to: parseAddressList(to),
					cc: parseAddressList(cc ?? []),
					bcc: parseAddressList(bcc ?? []),
					subject,
					html: composeBody(textToComposeHtml(body), account.signature),
					inReplyTo: null,
					references: [],
					attachments: files
				};
				return deliver(draft, how, { uploadIds });
			})
	);

	server.registerTool(
		'create_meeting',
		{
			title: 'Create meeting',
			description:
				'Invites attendees to a new meeting (not all-day, not recurring). The title is the subject and the ' +
				'body its description. With mode "draft" the invitation waits in Drafts for the user; send_draft ' +
				"sends it. Exchange accounts add sent meetings to the user's calendar and track the answers; " +
				'other accounts only email the invitation.',
			inputSchema: z.object({
				account: accountRef,
				required: recipientList.min(1).describe('Required attendees, as email addresses.'),
				optional: recipientList.optional().describe('Optional attendees.'),
				subject: z.string().min(1).max(998),
				body: z
					.string()
					.describe('Plain text description; the account signature is added.')
					.default(''),
				start: wallClock,
				end: wallClock,
				time_zone: timeZone,
				location: z.string().max(500).optional(),
				mode
			})
		},
		({
			account: accountArg,
			required,
			optional,
			subject,
			body,
			start,
			end,
			time_zone,
			location,
			mode: how
		}) =>
			guard(async () => {
				const account = access.require(accountArg, how === 'send' ? 'send' : 'organize');
				const draft: Draft = {
					accountId: account.id,
					to: parseAddressList(required),
					cc: parseAddressList(optional ?? []),
					bcc: [],
					subject,
					html: composeBody(textToComposeHtml(body), account.signature),
					inReplyTo: null,
					references: [],
					attachments: [],
					meeting: {
						uid: '',
						sequence: 0,
						start: instantIn(start, time_zone),
						end: instantIn(end, time_zone),
						location: location?.trim() || null
					}
				};
				if (Date.parse(draft.meeting!.end) <= Date.parse(draft.meeting!.start)) {
					throw new MailError('The meeting must end after it starts.', 400);
				}
				return { ...(await deliver(draft, how)), start, end, time_zone };
			})
	);

	const sentInvitationRef = messageRef.describe(
		'The invitation the user sent for the meeting (in Sent Items), or any later update; changes apply ' +
			'to the meeting as it is now.'
	);

	server.registerTool(
		'update_meeting',
		{
			title: 'Update meeting',
			description:
				'Changes a meeting the user organized and sent (not recurring) and notifies attendees ' +
				'immediately; there is no draft mode. Only use it when the user asked to change the meeting. ' +
				'If only required and optional change, added attendees (and those moved between required and ' +
				'optional) get the invitation, removed attendees a cancellation, and everyone else nothing. ' +
				'Any other change sends the update to all attendees, and removed attendees get a ' +
				'cancellation. Fields left out keep their current values; a new start without an end keeps the ' +
				"duration. Exchange accounts update the user's calendar; other accounts email the update.",
			inputSchema: z.object({
				message_ref: sentInvitationRef,
				subject: z.string().min(1).max(998).optional(),
				body: z
					.string()
					.optional()
					.describe('New plain text description; the account signature is added.'),
				start: wallClock.optional(),
				end: wallClock.optional(),
				time_zone: timeZone
					.optional()
					.describe('IANA time zone of start and end; required with them.'),
				location: z.string().max(500).optional().describe('An empty string removes the location.'),
				required: recipientList.min(1).optional().describe('All required attendees.'),
				optional: recipientList.optional().describe('All optional attendees.')
			})
		},
		({ message_ref, subject, body, start, end, time_zone, location, required, optional }) =>
			guard(async () => {
				const changes = [subject, body, start, end, location, required, optional];
				if (changes.every((change) => change === undefined)) {
					throw new MailError('Give at least one change.', 400);
				}
				if ((start || end) && !time_zone) {
					throw new MailError('Give time_zone with start and end.', 400);
				}
				const result = await withMessage(message_ref, async (ref) => {
					const { account } = await access.requireMessage(ref, 'send');
					return updateMeeting(userId, ref, {
						subject,
						html:
							body === undefined
								? undefined
								: composeBody(textToComposeHtml(body), account.signature),
						start: start && instantIn(start, time_zone!),
						end: end && instantIn(end, time_zone!),
						location: location === undefined ? undefined : location.trim() || null,
						required: required && parseAddressList(required),
						optional: optional && parseAddressList(optional)
					});
				});
				const zone = time_zone ?? 'UTC';
				return {
					status: 'sent',
					subject: result.subject,
					start: formatWallClock(Date.parse(result.start), zone),
					end: formatWallClock(Date.parse(result.end), zone),
					time_zone: zone,
					to: result.to.map(formatAddress),
					...(result.cc.length && { cc: result.cc.map(formatAddress) })
				};
			})
	);

	server.registerTool(
		'cancel_meeting',
		{
			title: 'Cancel meeting',
			description:
				'Cancels a meeting the user organized and sent (not recurring) and tells all attendees ' +
				'immediately; there is no draft mode. Only use it when the user asked to cancel the meeting.',
			inputSchema: z.object({
				message_ref: sentInvitationRef,
				comment: z
					.string()
					.optional()
					.describe('Plain text note to the attendees; the account signature is added.')
			})
		},
		({ message_ref, comment }) =>
			guard(async () => {
				const result = await withMessage(message_ref, async (ref) => {
					const { account } = await access.requireMessage(ref, 'send');
					const html = comment?.trim()
						? composeBody(textToComposeHtml(comment), account.signature)
						: null;
					return cancelMeeting(userId, ref, html);
				});
				return {
					status: 'sent',
					subject: result.subject,
					to: [...result.to, ...result.cc].map(formatAddress)
				};
			})
	);

	server.registerTool(
		'find_meeting_times',
		{
			title: 'Find meeting times',
			description:
				'Exchange accounts only. Returns the busy times of the user and the attendees between two days, and ' +
				'the periods in working hours on weekdays when everyone with a known calendar is free for the ' +
				'duration. Attendees outside the organization are usually listed as unknown.',
			inputSchema: z.object({
				account: accountRef,
				attendees: recipientList.min(1).max(20),
				date_from: date,
				date_to: date.describe('Last day, inclusive; the span covers at most 14 days.'),
				duration_minutes: z.number().int().min(5).max(480),
				time_zone: timeZone,
				workday_start: clockTime.default('08:00').describe('HH:MM in time_zone.'),
				workday_end: clockTime.default('18:00').describe('HH:MM in time_zone.')
			})
		},
		({
			account: accountArg,
			attendees,
			date_from,
			date_to,
			duration_minutes,
			time_zone,
			workday_start,
			workday_end
		}) =>
			guard(async () => {
				const account = access.require(accountArg, 'read');
				const times = await findMeetingTimes(account, {
					attendees: parseAddressList(attendees).map((a) => a.address),
					from: date_from,
					to: date_to,
					durationMinutes: duration_minutes,
					timeZone: time_zone,
					workday: { start: workday_start, end: workday_end }
				});
				const local = (range: { start: string; end: string }) => ({
					start: formatWallClock(Date.parse(range.start), time_zone),
					end: formatWallClock(Date.parse(range.end), time_zone)
				});
				const own = account.email.toLowerCase();
				const unknown = times.attendees.filter((a) => !a.busy).map((a) => a.address);
				return {
					time_zone,
					free: times.free.map(local),
					busy: Object.fromEntries(
						times.attendees
							.filter((a) => a.busy)
							.map((a) => [
								a.address.toLowerCase() === own ? 'you' : a.address,
								a.busy!.map((b) => ({ ...local(b), ...(b.tentative && { tentative: true }) }))
							])
					),
					...(unknown.length && { unknown })
				};
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
