import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { MessageDetail } from '#lib/mail-types.js';
import { errorMessage, MailError } from '#lib/server/mail/errors.js';
import { InvalidMessageRefError } from '#lib/server/mail/message-ref.js';
import {
	deleteMessages,
	getMessage,
	groupRefs,
	moveMessages,
	resolveRef,
	setFlags,
	type MoveTarget
} from '#lib/server/mail/messages.js';
import type { Actions, PageServerLoad } from './$types';

type OpenedMessage = { detail: MessageDetail; error: null } | { detail: null; error: string };

async function openMessage(userId: string, ref: string): Promise<OpenedMessage> {
	try {
		const { account, locator } = await resolveRef(userId, ref);
		return { detail: (await getMessage(account, locator)).detail, error: null };
	} catch (error) {
		if (error instanceof MailError || error instanceof InvalidMessageRefError) {
			return { detail: null, error: error.message };
		}
		throw error;
	}
}

/**
 * The open message (`?m=`), streamed so the reader opens before the body arrives. Loading never
 * marks it read (links preload on hover); the page does that once it is shown.
 */
export const load: PageServerLoad = ({ url, locals }) => {
	const ref = url.searchParams.get('m');
	return { message: ref ? openMessage(locals.user.id, ref) : null };
};

const refsSchema = z.array(z.string().min(1)).min(1).max(500);

async function refsFrom(request: Request) {
	const form = await request.formData();
	return { form, refs: refsSchema.parse(form.getAll('ref')) };
}

async function run(fn: () => Promise<void>) {
	try {
		await fn();
		return { ok: true };
	} catch (error) {
		if (error instanceof MailError) return fail(error.status, { error: error.message });
		if (error instanceof InvalidMessageRefError || error instanceof z.ZodError) {
			return fail(400, { error: 'Select at least one message.' });
		}
		return fail(500, { error: errorMessage(error) });
	}
}

const MOVE_TARGETS = ['archive', 'trash', 'spam', 'inbox'] as const;

export const actions: Actions = {
	flag: ({ request, locals }) =>
		run(async () => {
			const { form, refs } = await refsFrom(request);
			const flag = (name: string) => (form.has(name) ? form.get(name) === 'true' : undefined);
			await setFlags(await groupRefs(locals.user.id, refs), {
				seen: flag('seen'),
				flagged: flag('flagged')
			});
		}),
	move: ({ request, locals }) =>
		run(async () => {
			const { form, refs } = await refsFrom(request);
			const target = String(form.get('target') ?? '');
			const destination: MoveTarget = (MOVE_TARGETS as readonly string[]).includes(target)
				? (target as MoveTarget)
				: { path: target };
			if (!target) throw new MailError('Choose a folder.', 400);
			await moveMessages(await groupRefs(locals.user.id, refs), destination);
		}),
	delete: ({ request, locals }) =>
		run(async () => {
			const { refs } = await refsFrom(request);
			await deleteMessages(await groupRefs(locals.user.id, refs));
		})
};
