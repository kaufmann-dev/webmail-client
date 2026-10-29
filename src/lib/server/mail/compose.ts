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
	meetingNotices,
	meetingRequest,
	parseInvitation,
	type MeetingRequest
} from './invitations';
import { recordResponse } from './invitation-responses';
import { decodeMessageRef, encodeMessageRef } from './message-ref';
import {
	deleteMessages,
	findMessage,
	forgetMessage,
	getAttachments,
	getMessage,
	groupRefs,
	markAnswered,
	resolveRef,
	searchUids,
	type ReadMessage
} from './messages';
import { PROVIDER_CONFIG } from './providers';
import { latestSentMeeting, recordSentMeeting } from './sent-meetings';
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
	// Fresh: Exchange keeps a draft's item ID when another program edits it.
	const read = await getMessage(account, locator, { fresh: true });
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
	/** The message went out, but the draft it replaces could not be deleted. */
	draftKept: boolean;
}

/**
 * Sends over SMTP (or through Exchange), stores a Sent copy where the provider does not, removes
 * the draft it came from, and marks the answered message: `answersRef`, or else the message its
 * In-Reply-To names (a reply sent from its draft). Over SMTP, `deliverTo` limits delivery
 * to some of the recipients while the message still names all of them; with none, the message is
 * only stored in Sent.
 */
export async function sendDraft(
	userId: string,
	input: Draft,
	options: {
		replacesDraftRef?: string | null;
		answersRef?: string | null;
		deliverTo?: Address[];
	} = {}
): Promise<SendResult> {
	const account = await getAccount(userId, input.accountId);
	const draft = withMeetingUid(account, input);
	if (!recipients(draft).length) throw new MailError('Add at least one recipient.', 400);
	checkMeeting(draft, true);
	const messageId = newMessageId(account);
	const date = new Date();
	const deliverTo = options.deliverTo?.map((a) => a.address) ?? recipients(draft);
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
	} else if (deliverTo.length) {
		const raw = await buildRaw(account, draft, { messageId, date, keepBcc: false });
		const transport = createSmtpTransport(account.provider, await mailAuth(account));
		try {
			await transport.sendMail({ envelope: { from: account.email, to: deliverTo }, raw });
		} catch (error) {
			throw new MailError(`Sending failed: ${errorMessage(error)}`, 502);
		} finally {
			transport.close();
		}
	}

	// The message is out; the follow-up bookkeeping must not report the send as failed. A message
	// delivered to no one gets no Sent copy from the provider either.
	if (
		account.provider !== 'exchange' &&
		(PROVIDER_CONFIG[account.provider].appendToSent || !deliverTo.length)
	) {
		const sent = await resolveFolder(account, 'sent').catch(() => null);
		if (sent) {
			const copy = await buildRaw(account, draft, { messageId, date, keepBcc: true });
			await withClient(account, (client) => client.append(sent, copy, ['\\Seen'], date)).catch(
				() => undefined
			);
		}
	}
	const draftKept = options.replacesDraftRef
		? await groupRefs(userId, [options.replacesDraftRef])
				.then(deleteMessages)
				.then(
					() => false,
					() => true
				)
		: false;
	// A reply sent from its draft no longer knows the ref it answers; its In-Reply-To finds it.
	const { inReplyTo } = draft;
	const answersRef =
		options.answersRef ??
		(inReplyTo
			? await requireFolder(account, 'inbox')
					.then((inbox) => findMessage(account, inReplyTo, inbox))
					.catch(() => null)
			: null);
	if (answersRef) {
		await groupRefs(userId, [answersRef])
			.then(markAnswered)
			.catch(() => undefined);
	}
	return {
		messageId: account.provider === 'exchange' && draft.meeting ? null : messageId,
		to: draft.to,
		cc: draft.cc,
		bcc: draft.bcc,
		subject: draft.subject,
		draftKept
	};
}

/**
 * Answers an invitation: sends the iMIP reply to its organizer, marks the invitation answered,
 * and records the answer, which the invitation's own calendar part never shows.
 */
export async function respondToInvitation(
	userId: string,
	ref: string,
	response: InvitationResponse
): Promise<SendResult> {
	const { account, locator } = await resolveRef(userId, ref);
	const { calendar, detail } = await getMessage(account, locator);
	if (!calendar) throw new MailError('This message has no invitation.', 400);
	const reply = invitationReply(
		calendar,
		{ name: account.displayName, address: account.email },
		response
	);
	let result: SendResult;
	// Exchange answers its own meeting requests, which also keeps its calendar current.
	if (locator.kind === 'ews' && (await ews.respondToMeeting(account, locator.itemId, response))) {
		result = {
			messageId: null,
			to: [reply.organizer],
			cc: [],
			bcc: [],
			subject: reply.subject,
			draftKept: false
		};
	} else {
		result = await sendDraft(
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
	const uid = detail.invitation?.uid;
	if (uid) await recordResponse(account.id, uid, detail.invitation?.sequence ?? 0, response);
	forgetMessage(ref);
	return result;
}

type MeetingDraft = Draft & { meeting: Meeting };

/** The meeting draft an invitation the user sent describes. */
function invitationDraft(account: MailAccount, read: ReadMessage, meeting: Meeting): MeetingDraft {
	const { detail } = read;
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

/**
 * A meeting the user organizes and has sent, as it is now, from its invitation or any update of
 * it: on Exchange from its calendar item (`item`), elsewhere from the newest version this app
 * sent, which an older invitation must not undo.
 */
async function sentMeeting(
	userId: string,
	ref: string
): Promise<{ account: MailAccount; current: MeetingDraft; item: ews.OrganizedMeeting | null }> {
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
	const sent = invitationDraft(account, read, meeting);
	if (account.provider === 'exchange') {
		const item = await ews.findOrganizedMeeting(account, meeting.uid, meeting.start, meeting.end);
		const { start, end, location } = item;
		return {
			account,
			item,
			current: {
				...sent,
				to: item.required,
				cc: item.optional,
				subject: item.subject,
				meeting: { ...meeting, start, end, location }
			}
		};
	}
	const latest = await latestSentMeeting(account.id, meeting.uid);
	if (latest?.canceled && latest.sequence >= meeting.sequence) {
		throw new MailError('This meeting was canceled.', 409);
	}
	if (!latest || latest.sequence <= meeting.sequence) return { account, item: null, current: sent };
	const newerRef = await findMessage(
		account,
		latest.messageId,
		await requireFolder(account, 'sent')
	);
	const newer = newerRef ? await getMessage(account, decodeMessageRef(newerRef)) : null;
	const newerMeeting = newer ? meetingOf(account, newer) : null;
	if (!newer || !newerMeeting) {
		throw new MailError(
			'A newer update of this meeting is no longer in Sent, so it cannot be changed.',
			409
		);
	}
	return { account, item: null, current: invitationDraft(account, newer, newerMeeting) };
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
 * Changes a meeting the user sent, as it is now (see `sentMeeting`), and tells the attendees at once. When only the attendees change,
 * added attendees (and those whose role changed) get the invitation, removed ones a cancellation,
 * and the others nothing; any other change goes to all attendees. Exchange updates the calendar
 * item and notifies the attendees itself; other accounts send the invitation again with a higher
 * sequence, and a cancellation to removed attendees.
 */
export async function updateMeeting(
	userId: string,
	ref: string,
	changes: MeetingUpdate
): Promise<SendResult & Pick<Meeting, 'start' | 'end'>> {
	const { account, current, item } = await sentMeeting(userId, ref);
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
	const subjectChanged = updated.subject !== current.subject;
	const locationChanged = updated.meeting.location !== was.location;
	const othersChanged =
		timeChanged || subjectChanged || locationChanged || changes.html !== undefined;
	if (!othersChanged && !changes.required && !changes.optional) {
		throw new MailError('Nothing changes in this meeting.', 400);
	}

	if (item) {
		const attendees = await ews.updateMeeting(account, item, {
			subject: subjectChanged ? updated.subject : undefined,
			html:
				changes.html === undefined
					? undefined
					: outgoingHtml(withoutDataImages(changes.html), toSummary(account).font),
			start: timeChanged ? start : undefined,
			end: timeChanged ? end : undefined,
			location: locationChanged ? updated.meeting.location : undefined,
			required: changes.required,
			optional: changes.optional
		});
		return {
			messageId: null,
			to: attendees.required,
			cc: attendees.optional,
			bcc: [],
			subject: updated.subject,
			draftKept: false,
			start,
			end
		};
	}

	const notices = meetingNotices(
		{ required: current.to, optional: current.cc },
		{ required: updated.to, optional: updated.cc },
		othersChanged
	);
	if (!notices.request.length && !notices.cancel.length) {
		throw new MailError('Nothing changes for any attendee.', 400);
	}
	if (notices.cancel.length) {
		await sendDraft(
			userId,
			cancellation(
				account,
				{ ...updated, to: notices.cancel, cc: [] },
				textToComposeHtml(CANCELED_TEXT)
			)
		);
	}
	// Naming every attendee, so its copy in Sent describes the meeting. Only once it is out does it
	// become the newest version, so after a failure, trying again sends the cancellations again.
	const result = await sendDraft(userId, updated, { deliverTo: notices.request }).catch(
		(error: unknown) => {
			if (!notices.cancel.length) throw error;
			throw new MailError(
				`Removed attendees got the cancellation, but the update could not be sent (${errorMessage(error)}). Trying again sends both.`,
				502
			);
		}
	);
	if (result.messageId) {
		await recordSentMeeting(account.id, was.uid, {
			sequence: updated.meeting.sequence,
			messageId: result.messageId,
			canceled: false
		}).catch(() => undefined);
	}
	return { ...result, start, end };
}

/** Cancels a meeting the user sent and tells its attendees at once. */
export async function cancelMeeting(
	userId: string,
	ref: string,
	html: string | null
): Promise<SendResult> {
	const { account, current, item } = await sentMeeting(userId, ref);
	const body = html ?? textToComposeHtml(CANCELED_TEXT);
	if (item) {
		await ews.cancelMeeting(
			account,
			item,
			outgoingHtml(withoutDataImages(body), toSummary(account).font)
		);
		return {
			messageId: null,
			to: current.to,
			cc: current.cc,
			bcc: [],
			subject: `Canceled: ${current.subject}`,
			draftKept: false
		};
	}
	const meeting = { ...current.meeting, sequence: current.meeting.sequence + 1 };
	const result = await sendDraft(userId, cancellation(account, { ...current, meeting }, body));
	if (result.messageId) {
		await recordSentMeeting(account.id, meeting.uid, {
			sequence: meeting.sequence,
			messageId: result.messageId,
			canceled: true
		}).catch(() => undefined);
	}
	return result;
}

/** Saves to the Drafts folder, replacing an earlier version; returns the new draft's ref and Message-ID. */
export async function saveDraft(
	userId: string,
	input: Draft,
	replacesRef?: string | null
): Promise<{ ref: string; messageId: string }> {
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
	return { ref, messageId };
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
		const uids = await searchUids(client, account, { header: { 'message-id': messageId } });
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
