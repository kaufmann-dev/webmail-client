import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { EMPTY_LINE } from '../../html';
import type { Address, AttachmentInfo, InvitationResponse } from '../../mail-types';
import { getAccount, listAccounts } from './accounts';
import { mailAuth } from './credentials';
import { errorMessage, MailError } from './errors';
import { requireFolder, resolveFolder } from './folders';
import * as ews from './ews/compose';
import { outgoingHtml, plainTextOf, textToComposeHtml } from './html-body';
import { withClient, withMailbox } from './imap';
import { invitationReply } from './invitations';
import { encodeMessageRef } from './message-ref';
import {
	deleteMessages,
	getAttachments,
	getMessage,
	groupRefs,
	markAnswered,
	resolveRef
} from './messages';
import { PROVIDER_CONFIG } from './providers';
import { createSmtpTransport } from './smtp';
import {
	composeBody,
	forwardedBlock,
	forwardSubject,
	quoteOriginal,
	replyRecipients,
	replyReferences,
	replySubject,
	type OriginalMessage
} from './threading';
import type { MailAccount } from './types';

export interface OutgoingAttachment {
	filename: string;
	contentType: string;
	content: Buffer;
}

/**
 * Everything needed to send or save a message. Replies carry `inReplyTo` and `references`, which
 * are only ever derived from the original message by `prepareReply` / `prepareForward`.
 */
export interface Draft {
	accountId: string;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
	/** Sanitized editor HTML, without the document around it. */
	html: string;
	inReplyTo: string | null;
	references: string[];
	attachments: OutgoingAttachment[];
	/** An iMIP calendar reply, sent as a `text/calendar` alternative. */
	calendar?: { method: 'REPLY'; content: string };
}

export interface PreparedDraft {
	draft: Draft;
	/** The HTML placed below the user's own text: signature plus quote or forwarded message. */
	suffix: string;
	/** Attachments of the original message (forwards), addressable by part ID. */
	sourceAttachments: AttachmentInfo[];
}

async function loadOriginal(userId: string, ref: string) {
	const { account, locator } = await resolveRef(userId, ref);
	const { detail, sentAt } = await getMessage(account, locator);
	const original: OriginalMessage = {
		messageId: detail.messageId,
		references: detail.references,
		subject: detail.subject,
		from: detail.from,
		replyTo: detail.replyTo,
		to: detail.to,
		cc: detail.cc,
		date: sentAt,
		html: detail.html
	};
	return { account, locator, original, attachments: detail.attachments };
}

/** A threaded reply: In-Reply-To, References, `Re:` subject, recipients, and the quoted original. */
export async function prepareReply(
	userId: string,
	ref: string,
	replyAll: boolean
): Promise<PreparedDraft> {
	const { account, original } = await loadOriginal(userId, ref);
	const own = (await listAccounts(userId)).map((a) => a.email);
	const { to, cc } = replyRecipients(original, own, replyAll);
	const suffix = composeBody('', account.signature, quoteOriginal(original));
	return {
		suffix,
		sourceAttachments: [],
		draft: {
			accountId: account.id,
			to,
			cc,
			bcc: [],
			subject: replySubject(original.subject),
			html: EMPTY_LINE + suffix,
			inReplyTo: original.messageId,
			references: replyReferences(original),
			attachments: []
		}
	};
}

export async function prepareForward(
	userId: string,
	ref: string,
	includeAttachments: boolean
): Promise<PreparedDraft> {
	const { account, locator, original, attachments } = await loadOriginal(userId, ref);
	const suffix = composeBody('', account.signature, forwardedBlock(original));
	return {
		suffix,
		sourceAttachments: attachments,
		draft: {
			accountId: account.id,
			to: [],
			cc: [],
			bcc: [],
			subject: forwardSubject(original.subject),
			html: EMPTY_LINE + suffix,
			inReplyTo: null,
			references: replyReferences(original),
			attachments: includeAttachments
				? await getAttachments(
						account,
						locator,
						attachments.map((a) => a.partId)
					)
				: []
		}
	};
}

/** A saved draft, back as editable fields; its threading headers are kept. */
export async function loadDraft(userId: string, ref: string): Promise<Draft> {
	const { account, locator } = await resolveRef(userId, ref);
	const { detail } = await getMessage(account, locator);
	return {
		accountId: account.id,
		to: detail.to,
		cc: detail.cc,
		bcc: detail.bcc,
		subject: detail.subject,
		html: detail.html,
		inReplyTo: detail.inReplyTo,
		references: detail.references,
		attachments: await getAttachments(
			account,
			locator,
			detail.attachments.map((a) => a.partId)
		)
	};
}

function newMessageId(account: MailAccount): string {
	return `<${randomUUID()}@${account.email.split('@')[1] ?? 'localhost'}>`;
}

async function buildRaw(
	account: MailAccount,
	draft: Draft,
	headers: { messageId: string; date: Date; keepBcc: boolean }
): Promise<Buffer> {
	const composer = new MailComposer({
		from: { name: account.displayName, address: account.email },
		to: draft.to,
		cc: draft.cc,
		bcc: draft.bcc,
		subject: draft.subject,
		html: outgoingHtml(draft.html),
		text: plainTextOf(draft.html),
		// Pasted images, signature images, and quoted inline images go out as embedded parts.
		attachDataUrls: true,
		inReplyTo: draft.inReplyTo ?? undefined,
		references: draft.references.length ? draft.references : undefined,
		attachments: draft.attachments,
		icalEvent: draft.calendar,
		messageId: headers.messageId,
		date: headers.date
	});
	const message = composer.compile();
	message.keepBcc = headers.keepBcc;
	return message.build();
}

function recipients(draft: Draft): string[] {
	return [...draft.to, ...draft.cc, ...draft.bcc].map((a) => a.address);
}

export interface SendResult {
	/** Null for meeting responses Exchange composes itself. */
	messageId: string | null;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
}

/**
 * Sends over SMTP (or through Exchange), stores a Sent copy where the provider does not, removes
 * the draft it came from, and marks the answered message.
 */
export async function sendDraft(
	userId: string,
	draft: Draft,
	options: { replacesDraftRef?: string | null; answersRef?: string | null } = {}
): Promise<SendResult> {
	const account = await getAccount(userId, draft.accountId);
	if (!recipients(draft).length) throw new MailError('Add at least one recipient.', 400);
	const messageId = newMessageId(account);
	const date = new Date();
	if (account.provider === 'exchange') {
		const raw = await buildRaw(account, draft, { messageId, date, keepBcc: true });
		try {
			await ews.sendMessage(account, raw);
		} catch (error) {
			throw new MailError(`Sending failed: ${errorMessage(error)}`, 502);
		}
	} else {
		const raw = await buildRaw(account, draft, { messageId, date, keepBcc: false });
		const transport = createSmtpTransport(account.provider, await mailAuth(account));
		try {
			await transport.sendMail({ envelope: { from: account.email, to: recipients(draft) }, raw });
		} catch (error) {
			throw new MailError(`Sending failed: ${errorMessage(error)}`, 502);
		} finally {
			transport.close();
		}
	}

	// The message is out; the follow-up bookkeeping must not report the send as failed.
	if (account.provider !== 'exchange' && PROVIDER_CONFIG[account.provider].appendToSent) {
		const sent = await resolveFolder(account, 'sent').catch(() => null);
		if (sent) {
			const copy = await buildRaw(account, draft, { messageId, date, keepBcc: true });
			await withClient(account, (client) => client.append(sent, copy, ['\\Seen'], date)).catch(
				() => undefined
			);
		}
	}
	if (options.replacesDraftRef) {
		await groupRefs(userId, [options.replacesDraftRef])
			.then(deleteMessages)
			.catch(() => undefined);
	}
	if (options.answersRef) {
		await groupRefs(userId, [options.answersRef])
			.then(markAnswered)
			.catch(() => undefined);
	}
	return { messageId, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject };
}

/** Answers an invitation: sends the iMIP reply to its organizer and marks the invitation answered. */
export async function respondToInvitation(
	userId: string,
	ref: string,
	response: InvitationResponse
): Promise<SendResult> {
	const { account, locator } = await resolveRef(userId, ref);
	const { calendar } = await getMessage(account, locator);
	if (!calendar) throw new MailError('This message has no invitation.', 400);
	const reply = invitationReply(
		calendar,
		{ name: account.displayName, address: account.email },
		response
	);
	// Exchange answers its own meeting requests, which also keeps its calendar current.
	if (locator.kind === 'ews' && (await ews.respondToMeeting(account, locator.itemId, response))) {
		return {
			messageId: null,
			to: [reply.organizer],
			cc: [],
			bcc: [],
			subject: reply.subject
		};
	}
	return sendDraft(
		userId,
		{
			accountId: account.id,
			to: [reply.organizer],
			cc: [],
			bcc: [],
			subject: reply.subject,
			html: textToComposeHtml(reply.text),
			inReplyTo: null,
			references: [],
			attachments: [],
			calendar: { method: 'REPLY', content: reply.ics }
		},
		{ answersRef: ref }
	);
}

/** Saves to the Drafts folder, replacing an earlier version; returns the new draft's ref. */
export async function saveDraft(
	userId: string,
	draft: Draft,
	replacesRef?: string | null
): Promise<string> {
	const account = await getAccount(userId, draft.accountId);
	const path = await requireFolder(account, 'drafts');
	const messageId = newMessageId(account);
	const raw = await buildRaw(account, draft, { messageId, date: new Date(), keepBcc: true });
	const ref =
		account.provider === 'exchange'
			? encodeMessageRef({
					kind: 'ews',
					accountId: account.id,
					path,
					itemId: await ews.saveDraft(account, raw)
				})
			: await appendDraft(account, path, raw, messageId);
	if (replacesRef && replacesRef !== ref) {
		await groupRefs(userId, [replacesRef])
			.then(deleteMessages)
			.catch(() => undefined);
	}
	return ref;
}

async function appendDraft(
	account: MailAccount,
	path: string,
	raw: Buffer,
	messageId: string
): Promise<string> {
	const appended = await withClient(account, (client) =>
		client.append(path, raw, ['\\Draft', '\\Seen'])
	);
	if (appended && appended.uid && appended.uidValidity !== undefined) {
		return encodeMessageRef({
			kind: 'imap',
			accountId: account.id,
			path,
			uidValidity: String(appended.uidValidity),
			uid: appended.uid
		});
	}
	// Servers without UIDPLUS do not report the new UID; find the draft by its Message-ID.
	return withMailbox(account, path, async (client, mailbox) => {
		const uids =
			(await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
		if (!uids.length) throw new MailError('The draft was saved but could not be located.', 502);
		return encodeMessageRef({
			kind: 'imap',
			accountId: account.id,
			path,
			uidValidity: String(mailbox.uidValidity),
			uid: Math.max(...uids)
		});
	});
}
