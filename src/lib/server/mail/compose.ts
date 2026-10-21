import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { EMPTY_LINE } from '../../html';
import type { Address, AttachmentInfo, InvitationResponse } from '../../mail-types';
import { getAccount, listAccounts, toSummary } from './accounts';
import { mailAuth } from './credentials';
import { errorMessage, MailError } from './errors';
import { requireFolder, resolveFolder } from './folders';
import * as ews from './ews/compose';
import {
	embedDataImages,
	outgoingHtml,
	plainTextOf,
	textToComposeHtml,
	withoutDataImages
} from './html-body';
import { withClient, withMailbox } from './imap';
import {
	invitationReply,
	meetingCancellation,
	meetingRequest,
	parseInvitation,
	type MeetingRequest
} from './invitations';
import { encodeMessageRef } from './message-ref';
import {
	deleteMessages,
	getAttachments,
	getMessage,
	groupRefs,
	markAnswered,
	resolveRef,
	type ReadMessage
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
	/** An iMIP reply or cancellation, sent as a `text/calendar` alternative. */
	calendar?: { method: 'REPLY' | 'CANCEL'; content: string };
	/** Makes the message an invitation: `to` are required attendees, `cc` optional ones. */
	meeting?: Meeting;
}

/** A meeting the user organizes; the title is the subject and the description the body. */
export interface Meeting {
	/** Empty for a new meeting, which gets one when it is saved or sent. */
	uid: string;
	/** The iCalendar SEQUENCE: 0 until the sent meeting is updated. */
	sequence: number;
	/** ISO instants. */
	start: string;
	end: string;
	location: string | null;
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
	const read = await getMessage(account, locator);
	const { detail } = read;
	const meeting = meetingOf(account, read);
	if (meeting) {
		return {
			accountId: account.id,
			to: detail.to,
			cc: detail.cc,
			bcc: [],
			subject: detail.subject,
			html: detail.html,
			inReplyTo: null,
			references: [],
			attachments: [],
			meeting
		};
	}
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

function mailDomain(account: MailAccount): string {
	return account.email.split('@')[1] ?? 'localhost';
}

/** The draft with an iCalendar UID for a new meeting, shared by everything built from it. */
function withMeetingUid(account: MailAccount, draft: Draft): Draft {
	const { meeting } = draft;
	if (!meeting || meeting.uid) return draft;
	return { ...draft, meeting: { ...meeting, uid: `${randomUUID()}@${mailDomain(account)}` } };
}

/**
 * The meeting a saved draft carries: an invitation organized by the account itself, with a start,
 * an end, and a UID. Other calendar parts (invitations received, all-day events) are not meetings.
 */
export function meetingOf(account: MailAccount, read: ReadMessage): Meeting | null {
	const invitation = read.calendar ? parseInvitation(read.calendar, account.email) : null;
	if (
		!invitation ||
		invitation.method !== 'request' ||
		invitation.allDay ||
		invitation.recurring ||
		!invitation.end ||
		!invitation.uid ||
		!invitation.organizedByYou
	) {
		return null;
	}
	const { uid, sequence, start, end, location } = invitation;
	return { uid, sequence, start, end, location };
}

/** Rejects meetings Exchange and calendar programs would not accept; drafts only need a time. */
function checkMeeting(draft: Draft, sending: boolean) {
	const { meeting } = draft;
	if (!meeting) return;
	const start = Date.parse(meeting.start);
	const end = Date.parse(meeting.end);
	if (Number.isNaN(start) || Number.isNaN(end)) throw new MailError('Choose a meeting time.', 400);
	if (!sending) return;
	if (end <= start) throw new MailError('The meeting must end after it starts.', 400);
	if (draft.bcc.length) throw new MailError('Meetings have no Bcc attendees.', 400);
	if (!draft.subject.trim()) throw new MailError('Give the meeting a title.', 400);
}

function newMessageId(account: MailAccount): string {
	return `<${randomUUID()}@${mailDomain(account)}>`;
}

/** The iCalendar fields of a meeting message: `to` are required attendees, `cc` optional ones. */
function meetingRequestOf(account: MailAccount, draft: Draft, meeting: Meeting): MeetingRequest {
	return {
		...meeting,
		organizer: { name: account.displayName, address: account.email },
		required: draft.to,
		optional: draft.cc,
		title: draft.subject,
		description: plainTextOf(draft.html)
	};
}

async function buildRaw(
	account: MailAccount,
	draft: Draft,
	headers: { messageId: string; date: Date; keepBcc: boolean }
): Promise<Buffer> {
	const { html, images } = embedDataImages(draft.html, mailDomain(account));
	const { meeting } = draft;
	const icalEvent = meeting
		? { method: 'REQUEST', content: meetingRequest(meetingRequestOf(account, draft, meeting)) }
		: draft.calendar;
	const composer = new MailComposer({
		from: { name: account.displayName, address: account.email },
		to: draft.to,
		cc: draft.cc,
		bcc: draft.bcc,
		subject: draft.subject,
		html: outgoingHtml(html, toSummary(account).font),
		text: plainTextOf(draft.html),
		inReplyTo: draft.inReplyTo ?? undefined,
		references: draft.references.length ? draft.references : undefined,
		// Meetings carry no files; calendar programs would not keep them with the event.
		attachments: meeting ? images : [...draft.attachments, ...images],
		icalEvent,
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
	/** Null for meetings and meeting responses Exchange composes itself. */
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
	input: Draft,
	options: { replacesDraftRef?: string | null; answersRef?: string | null } = {}
): Promise<SendResult> {
	const account = await getAccount(userId, input.accountId);
	const draft = withMeetingUid(account, input);
	if (!recipients(draft).length) throw new MailError('Add at least one recipient.', 400);
	checkMeeting(draft, true);
	const messageId = newMessageId(account);
	const date = new Date();
	if (account.provider === 'exchange' && draft.meeting) {
		// A calendar item: Exchange sends the invitations, keeps the meeting, and tracks the answers.
		try {
			await ews.createMeeting(account, {
				subject: draft.subject,
				html: outgoingHtml(withoutDataImages(draft.html), toSummary(account).font),
				start: draft.meeting.start,
				end: draft.meeting.end,
				location: draft.meeting.location,
				required: draft.to,
				optional: draft.cc
			});
		} catch (error) {
			throw new MailError(`Sending failed: ${errorMessage(error)}`, 502);
		}
	} else if (account.provider === 'exchange') {
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
	return {
		messageId: account.provider === 'exchange' && draft.meeting ? null : messageId,
		to: draft.to,
		cc: draft.cc,
		bcc: draft.bcc,
		subject: draft.subject
	};
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

type MeetingDraft = Draft & { meeting: Meeting };

/** A meeting the user organizes and has sent, from its invitation (or an update of it). */
async function sentMeeting(
	userId: string,
	ref: string
): Promise<{ account: MailAccount; current: MeetingDraft }> {
	const { account, locator } = await resolveRef(userId, ref);
	const read = await getMessage(account, locator);
	const meeting = meetingOf(account, read);
	if (!meeting) {
		throw new MailError(
			'This message is not a meeting you organized. Use the invitation you sent (in Sent Items).',
			400
		);
	}
	if (locator.path === (await resolveFolder(account, 'drafts'))) {
		throw new MailError('This meeting has not been sent yet; send its draft instead.', 400);
	}
	const { detail } = read;
	return {
		account,
		current: {
			accountId: account.id,
			to: detail.to,
			cc: detail.cc,
			bcc: [],
			subject: detail.subject,
			html: detail.html,
			inReplyTo: null,
			references: [],
			attachments: [],
			meeting
		}
	};
}

const CANCELED_TEXT = 'This meeting has been canceled.';

/** The cancellation of a meeting for its `to` and `cc`, by email (iMIP CANCEL). */
function cancellation(account: MailAccount, meeting: MeetingDraft, html: string): Draft {
	return {
		accountId: account.id,
		to: meeting.to,
		cc: meeting.cc,
		bcc: [],
		subject: `Canceled: ${meeting.subject}`,
		html,
		inReplyTo: null,
		references: [],
		attachments: [],
		calendar: {
			method: 'CANCEL',
			content: meetingCancellation(meetingRequestOf(account, { ...meeting, html }, meeting.meeting))
		}
	};
}

/** Changes to a sent meeting; absent fields stay as they are. */
export interface MeetingUpdate {
	subject?: string;
	/** Sanitized editor HTML. */
	html?: string;
	/** ISO instants. A new start without an end keeps the duration. */
	start?: string;
	end?: string;
	/** Null removes the location. */
	location?: string | null;
	required?: Address[];
	optional?: Address[];
}

/**
 * Changes a meeting the user sent and sends the update to its attendees at once. Exchange updates
 * the calendar item (and tells removed attendees itself); other accounts send the invitation again
 * with a higher sequence, and a cancellation to removed attendees.
 */
export async function updateMeeting(
	userId: string,
	ref: string,
	changes: MeetingUpdate
): Promise<SendResult & Pick<Meeting, 'start' | 'end'>> {
	const { account, current } = await sentMeeting(userId, ref);
	const was = current.meeting;
	const start = changes.start ?? was.start;
	const end =
		changes.end ??
		(changes.start
			? new Date(Date.parse(start) + Date.parse(was.end) - Date.parse(was.start)).toISOString()
			: was.end);
	const updated: MeetingDraft = {
		...current,
		to: changes.required ?? current.to,
		cc: changes.optional ?? current.cc,
		subject: changes.subject ?? current.subject,
		html: changes.html ?? current.html,
		meeting: {
			...was,
			sequence: was.sequence + 1,
			start,
			end,
			location: changes.location === undefined ? was.location : changes.location
		}
	};
	if (!updated.to.length) throw new MailError('A meeting needs a required attendee.', 400);
	checkMeeting(updated, true);
	const timeChanged = start !== was.start || end !== was.end;

	if (account.provider === 'exchange') {
		await ews.updateMeeting(account, was, {
			subject: changes.subject,
			html:
				changes.html === undefined
					? undefined
					: outgoingHtml(withoutDataImages(changes.html), toSummary(account).font),
			start: timeChanged ? start : undefined,
			end: timeChanged ? end : undefined,
			location: changes.location,
			required: changes.required,
			optional: changes.optional
		});
		return {
			messageId: null,
			to: updated.to,
			cc: updated.cc,
			bcc: [],
			subject: updated.subject,
			start,
			end
		};
	}

	const result = await sendDraft(userId, updated);
	const kept = new Set([...updated.to, ...updated.cc].map((a) => a.address.toLowerCase()));
	const removed = [...current.to, ...current.cc].filter((a) => !kept.has(a.address.toLowerCase()));
	if (removed.length) {
		await sendDraft(
			userId,
			cancellation(account, { ...updated, to: removed, cc: [] }, textToComposeHtml(CANCELED_TEXT))
		);
	}
	return { ...result, start, end };
}

/** Cancels a meeting the user sent and tells its attendees at once. */
export async function cancelMeeting(
	userId: string,
	ref: string,
	html: string | null
): Promise<SendResult> {
	const { account, current } = await sentMeeting(userId, ref);
	const body = html ?? textToComposeHtml(CANCELED_TEXT);
	if (account.provider === 'exchange') {
		await ews.cancelMeeting(
			account,
			current.meeting,
			outgoingHtml(withoutDataImages(body), toSummary(account).font)
		);
		return {
			messageId: null,
			to: current.to,
			cc: current.cc,
			bcc: [],
			subject: `Canceled: ${current.subject}`
		};
	}
	const meeting = { ...current.meeting, sequence: current.meeting.sequence + 1 };
	return sendDraft(userId, cancellation(account, { ...current, meeting }, body));
}

/** Saves to the Drafts folder, replacing an earlier version; returns the new draft's ref. */
export async function saveDraft(
	userId: string,
	input: Draft,
	replacesRef?: string | null
): Promise<string> {
	const account = await getAccount(userId, input.accountId);
	const draft = withMeetingUid(account, input);
	checkMeeting(draft, false);
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
