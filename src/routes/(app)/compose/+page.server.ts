import { error, fail } from '@sveltejs/kit';
import type { AttachmentInfo, ComposeState } from '#lib/mail-types.js';
import { listAccounts, toSummary } from '#lib/server/mail/accounts.js';
import { parseAddressList } from '#lib/server/mail/addresses.js';
import {
	prepareForward,
	prepareReply,
	saveDraft,
	sendDraft,
	type Draft,
	type OutgoingAttachment
} from '#lib/server/mail/compose.js';
import { errorMessage, MailError } from '#lib/server/mail/errors.js';
import { InvalidMessageRefError } from '#lib/server/mail/message-ref.js';
import {
	deleteMessages,
	getAttachment,
	getMessage,
	groupRefs,
	resolveRef
} from '#lib/server/mail/messages.js';
import { formatAddress } from '#lib/server/mail/threading.js';
import type { Actions, PageServerLoad } from './$types';

const list = (addresses: { name: string; address: string }[]) =>
	addresses.map(formatAddress).join(', ');

function rethrow(e: unknown): never {
	if (e instanceof MailError) error(e.status, e.message);
	if (e instanceof InvalidMessageRefError) error(400, e.message);
	throw e;
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
		carried: []
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
				body: `\n\n${prepared.suffix}`,
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
				body: `\n\n${prepared.suffix}`,
				references: prepared.draft.references.join(' '),
				carriedRef: forward,
				carried: prepared.sourceAttachments
			};
		} else if (draft) {
			const { account, locator } = await resolveRef(userId, draft);
			const { detail } = await getMessage(account, locator);
			state = {
				...empty,
				mode: 'draft',
				accountId: account.id,
				to: list(detail.to),
				cc: list(detail.cc),
				bcc: list(detail.bcc),
				subject: detail.subject,
				body: detail.text,
				inReplyTo: detail.inReplyTo ?? '',
				references: detail.references.join(' '),
				replacesDraftRef: draft,
				carriedRef: draft,
				carried: detail.attachments
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
				body: account?.signature ? `\n\n-- \n${account.signature}` : ''
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
		for (const part of form.getAll('carriedPart')) {
			carried.push(await getAttachment(account, locator, String(part)));
		}
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
	const draft: Draft = {
		accountId: text('accountId'),
		to: parseAddressList(text('to')),
		cc: parseAddressList(text('cc')),
		bcc: parseAddressList(text('bcc')),
		subject: text('subject'),
		text: text('body').replace(/\r\n/g, '\n'),
		inReplyTo: text('inReplyTo') || null,
		references: text('references').split(/\s+/).filter(Boolean),
		attachments: [...carried, ...uploads]
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
			await sendDraft(locals.user.id, draft, { replacesDraftRef, answersRef });
			return { sent: true };
		}),
	save: ({ request, locals }) =>
		guard(async () => {
			const { draft, replacesDraftRef } = await draftFromForm(
				locals.user.id,
				await request.formData()
			);
			const ref = await saveDraft(locals.user.id, draft, replacesDraftRef);
			// The saved draft now holds every attachment, in order; later saves carry them from it.
			const carried: AttachmentInfo[] = draft.attachments.map((a, index) => ({
				partId: String(index),
				filename: a.filename,
				contentType: a.contentType,
				size: a.content.length
			}));
			return { saved: true, draftRef: ref, carried };
		}),
	discard: ({ request, locals }) =>
		guard(async () => {
			const ref = String((await request.formData()).get('replacesDraftRef') ?? '');
			if (ref) await deleteMessages(await groupRefs(locals.user.id, [ref]));
			return { discarded: true };
		})
};
