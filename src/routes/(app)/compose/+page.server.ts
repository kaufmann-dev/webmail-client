import { error, fail } from '@sveltejs/kit';
import { EMPTY_LINE } from '#lib/html.js';
import type { AttachmentInfo, ComposeState } from '#lib/mail-types.js';
import { listAccounts, toSummary } from '#lib/server/mail/accounts.js';
import { parseAddressList } from '#lib/server/mail/addresses.js';
import {
	meetingOf,
	prepareForward,
	prepareReply,
	saveDraft,
	sendDraft,
	type Draft,
	type Meeting,
	type OutgoingAttachment
} from '#lib/server/mail/compose.js';
import { errorMessage, MailError } from '#lib/server/mail/errors.js';
import { InvalidMessageRefError } from '#lib/server/mail/message-ref.js';
import {
	deleteMessages,
	getAttachments,
	getMessage,
	groupRefs,
	resolveRef
} from '#lib/server/mail/messages.js';
import { sanitizeEmailHtml } from '#lib/server/mail/render.js';
import { composeBody, formatAddress } from '#lib/server/mail/threading.js';
import type { Actions, PageServerLoad } from './$types';

const list = (addresses: { name: string; address: string }[]) =>
	addresses.map(formatAddress).join(', ');

function rethrow(e: unknown): never {
	if (e instanceof MailError) error(e.status, e.message);
	if (e instanceof InvalidMessageRefError) error(400, e.message);
	throw e;
}

/** Starts at the next full hour and lasts 30 minutes. */
function defaultMeeting() {
	const start = new Date();
	start.setUTCHours(start.getUTCHours() + 1, 0, 0, 0);
	const end = new Date(start.getTime() + 30 * 60_000);
	return { start: start.toISOString(), end: end.toISOString(), location: '' };
}

export const load: PageServerLoad = async ({ url, locals }) => {
	const userId = locals.user.id;
	const accounts = await listAccounts(userId);
	const params = url.searchParams;
	const empty = {
		inReplyTo: '',
		references: '',
		replacesDraftRef: '',
		answersRef: '',
		carriedRef: '',
		carried: [],
		meeting: null
	};
	let state: ComposeState;
	try {
		const reply = params.get('reply');
		const forward = params.get('forward');
		const draft = params.get('draft');
		if (reply) {
			const prepared = await prepareReply(userId, reply, params.get('all') === '1');
			const d = prepared.draft;
			state = {
				...empty,
				mode: 'reply',
				accountId: d.accountId,
				to: list(d.to),
				cc: list(d.cc),
				bcc: '',
				subject: d.subject,
				body: d.html,
				inReplyTo: d.inReplyTo ?? '',
				references: d.references.join(' '),
				answersRef: reply
			};
		} else if (forward) {
			const prepared = await prepareForward(userId, forward, false);
			state = {
				...empty,
				mode: 'forward',
				accountId: prepared.draft.accountId,
				to: '',
				cc: '',
				bcc: '',
				subject: prepared.draft.subject,
				body: prepared.draft.html,
				references: prepared.draft.references.join(' '),
				carriedRef: forward,
				carried: prepared.sourceAttachments
			};
		} else if (draft) {
			const { account, locator } = await resolveRef(userId, draft);
			// Fresh: Exchange keeps a draft's item ID when another program edits it.
			const read = await getMessage(account, locator, { fresh: true });
			const { detail } = read;
			const meeting = meetingOf(account, read);
			state = {
				...empty,
				mode: 'draft',
				accountId: account.id,
				to: list(detail.to),
				cc: list(detail.cc),
				bcc: list(detail.bcc),
				subject: detail.subject,
				body: detail.html,
				inReplyTo: detail.inReplyTo ?? '',
				references: detail.references.join(' '),
				replacesDraftRef: draft,
				// A meeting's only attachment is its own calendar file, which is rebuilt when sending.
				...(meeting
					? {
							meeting: {
								start: meeting.start,
								end: meeting.end,
								location: meeting.location ?? ''
							}
						}
					: { carriedRef: draft, carried: detail.attachments })
			};
		} else {
			const account = accounts.find((a) => a.id === params.get('account')) ?? accounts[0] ?? null;
			state = {
				...empty,
				mode: 'new',
				accountId: account?.id ?? '',
				to: params.get('to') ?? '',
				cc: '',
				bcc: '',
				subject: params.get('subject') ?? '',
				body: composeBody(EMPTY_LINE, account?.signature ?? null),
				meeting: params.get('meeting') === '1' ? defaultMeeting() : null
			};
		}
	} catch (e) {
		rethrow(e);
	}
	return { accounts: accounts.map(toSummary), compose: state };
};

/** Builds the outgoing message from the editor form. */
async function draftFromForm(userId: string, form: FormData) {
	const text = (name: string) => String(form.get(name) ?? '');
	const carried: OutgoingAttachment[] = [];
	const carriedRef = text('carriedRef');
	if (carriedRef) {
		const { account, locator } = await resolveRef(userId, carriedRef);
		carried.push(
			...(await getAttachments(account, locator, form.getAll('carriedPart').map(String)))
		);
	}
	const uploads = await Promise.all(
		form
			.getAll('files')
			.filter((file): file is File => file instanceof File && file.size > 0)
			.map(async (file) => ({
				filename: file.name,
				contentType: file.type || 'application/octet-stream',
				content: Buffer.from(await file.arrayBuffer())
			}))
	);
	const meetingStart = text('meetingStart');
	const meeting: Meeting | undefined = meetingStart
		? {
				uid: '',
				sequence: 0,
				start: meetingStart,
				end: text('meetingEnd'),
				location: text('meetingLocation').trim() || null
			}
		: undefined;
	const draft: Draft = {
		accountId: text('accountId'),
		to: parseAddressList(text('to')),
		cc: parseAddressList(text('cc')),
		bcc: parseAddressList(text('bcc')),
		subject: text('subject'),
		// The editor's HTML comes from the browser; it is always sanitized again here.
		html: sanitizeEmailHtml(text('body')).html,
		inReplyTo: text('inReplyTo') || null,
		references: text('references').split(/\s+/).filter(Boolean),
		attachments: meeting ? [] : [...carried, ...uploads],
		meeting
	};
	return {
		draft,
		replacesDraftRef: text('replacesDraftRef') || null,
		answersRef: text('answersRef') || null
	};
}

async function guard<T>(fn: () => Promise<T>) {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof MailError) return fail(e.status, { error: e.message });
		if (e instanceof InvalidMessageRefError) return fail(400, { error: e.message });
		return fail(500, { error: errorMessage(e) });
	}
}

export const actions: Actions = {
	send: ({ request, locals }) =>
		guard(async () => {
			const { draft, replacesDraftRef, answersRef } = await draftFromForm(
				locals.user.id,
				await request.formData()
			);
			const { draftKept } = await sendDraft(locals.user.id, draft, {
				replacesDraftRef,
				answersRef
			});
			return { sent: true, draftKept };
		}),
	save: ({ request, locals }) =>
		guard(async () => {
			const { draft, replacesDraftRef } = await draftFromForm(
				locals.user.id,
				await request.formData()
			);
			const { ref } = await saveDraft(locals.user.id, draft, replacesDraftRef);
			// The saved draft now holds every attachment; later saves carry them from it. A meeting
			// draft holds only its calendar file, which is rebuilt each time.
			const saved = await resolveRef(locals.user.id, ref);
			const carried: AttachmentInfo[] = draft.meeting
				? []
				: (await getMessage(saved.account, saved.locator)).detail.attachments;
			return { saved: true, draftRef: ref, carried };
		}),
	discard: ({ request, locals }) =>
		guard(async () => {
			const ref = String((await request.formData()).get('replacesDraftRef') ?? '');
			if (ref) await deleteMessages(await groupRefs(locals.user.id, [ref]));
			return { discarded: true };
		})
};
