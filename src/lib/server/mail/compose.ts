import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { AddressObject } from 'mailparser';
import type { Address, AttachmentInfo } from '../../mail-types';
import { getAccount, listAccounts } from './accounts';
import { mailAuth } from './credentials';
import { errorMessage, MailError } from './errors';
import { requireFolder, resolveFolder } from './folders';
import { withClient, withMailbox } from './imap';
import { encodeMessageRef } from './message-ref';
import { deleteMessages, getMessage, groupRefs, resolveRef, setFlags } from './messages';
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
	text: string;
	inReplyTo: string | null;
	references: string[];
	attachments: OutgoingAttachment[];
}

export interface PreparedDraft {
	draft: Draft;
	/** The text placed below the user's own text: signature plus quote or forwarded message. */
	suffix: string;
	/** Attachments of the original message (forwards), addressable by part ID. */
	sourceAttachments: AttachmentInfo[];
}

async function loadOriginal(userId: string, ref: string) {
	const { account, locator } = await resolveRef(userId, ref);
	const { detail, parsed } = await getMessage(account, locator);
	const original: OriginalMessage = {
		messageId: detail.messageId,
		references: detail.references,
		subject: detail.subject,
		from: detail.from,
		replyTo: detail.replyTo,
		to: detail.to,
		cc: detail.cc,
		date: parsed.date ?? null,
		text: detail.text
	};
	return { account, original, parsed, attachments: detail.attachments };
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
			text: suffix,
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
	const { account, original, parsed, attachments } = await loadOriginal(userId, ref);
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
			text: suffix,
			inReplyTo: null,
			references: replyReferences(original),
			attachments: includeAttachments
				? parsed.attachments
						.filter((a) => !a.related)
						.map((a) => ({
							filename: a.filename ?? 'attachment',
							contentType: a.contentType,
							content: a.content
						}))
				: []
		}
	};
}

function addressList(value: AddressObject | AddressObject[] | undefined): Address[] {
	const list = Array.isArray(value) ? value : value ? [value] : [];
	return list.flatMap((group) =>
		group.value.flatMap((entry) =>
			entry.address ? [{ name: entry.name ?? '', address: entry.address }] : []
		)
	);
}

/** A saved draft, back as editable fields; its threading headers are kept. */
export async function loadDraft(userId: string, ref: string): Promise<Draft> {
	const { account, locator } = await resolveRef(userId, ref);
	const { parsed } = await getMessage(account, locator);
	const references = Array.isArray(parsed.references)
		? parsed.references
		: (parsed.references?.split(/\s+/).filter(Boolean) ?? []);
	return {
		accountId: account.id,
		to: addressList(parsed.to),
		cc: addressList(parsed.cc),
		bcc: addressList(parsed.bcc),
		subject: parsed.subject ?? '',
		text: parsed.text ?? '',
		inReplyTo: parsed.inReplyTo ?? null,
		references,
		attachments: parsed.attachments.map((a) => ({
			filename: a.filename ?? 'attachment',
			contentType: a.contentType,
			content: a.content
		}))
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
		text: draft.text,
		inReplyTo: draft.inReplyTo ?? undefined,
		references: draft.references.length ? draft.references : undefined,
		attachments: draft.attachments,
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
	messageId: string;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
}

/**
 * Sends over SMTP, stores a Sent copy where the provider does not, removes the draft it came from,
 * and marks the answered message.
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
	const raw = await buildRaw(account, draft, { messageId, date, keepBcc: false });
	const transport = createSmtpTransport(account.provider, await mailAuth(account));
	try {
		await transport.sendMail({ envelope: { from: account.email, to: recipients(draft) }, raw });
	} catch (error) {
		throw new MailError(`Sending failed: ${errorMessage(error)}`, 502);
	} finally {
		transport.close();
	}

	// The message is out; the follow-up bookkeeping must not report the send as failed.
	if (PROVIDER_CONFIG[account.provider].appendToSent) {
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
			.then((groups) =>
				Promise.all(
					groups.map((group) =>
						withMailbox(group.account, group.path, (client) =>
							client.messageFlagsAdd(group.uids, ['\\Answered'], { uid: true })
						)
					)
				)
			)
			.catch(() => undefined);
	}
	return { messageId, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject };
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
	const appended = await withClient(account, (client) =>
		client.append(path, raw, ['\\Draft', '\\Seen'])
	);
	let ref: string;
	if (appended && appended.uid && appended.uidValidity !== undefined) {
		ref = encodeMessageRef({
			accountId: account.id,
			path,
			uidValidity: String(appended.uidValidity),
			uid: appended.uid
		});
	} else {
		// Servers without UIDPLUS do not report the new UID; find the draft by its Message-ID.
		ref = await withMailbox(account, path, async (client, mailbox) => {
			const uids =
				(await client.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
			if (!uids.length) throw new MailError('The draft was saved but could not be located.', 502);
			return encodeMessageRef({
				accountId: account.id,
				path,
				uidValidity: String(mailbox.uidValidity),
				uid: Math.max(...uids)
			});
		});
	}
	if (replacesRef && replacesRef !== ref) {
		await groupRefs(userId, [replacesRef])
			.then(deleteMessages)
			.catch(() => undefined);
	}
	return ref;
}

/** Marks a message read; used when the web UI opens it. */
export async function markRead(userId: string, ref: string): Promise<void> {
	await setFlags(await groupRefs(userId, [ref]), { seen: true });
}
