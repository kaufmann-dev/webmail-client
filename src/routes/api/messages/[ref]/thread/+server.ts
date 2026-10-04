import { error, json } from '@sveltejs/kit';
import { MailError } from '#lib/server/mail/errors.js';
import { InvalidMessageRefError } from '#lib/server/mail/message-ref.js';
import { getMessage, getThread, resolveRef } from '#lib/server/mail/messages.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const { account, locator } = await resolveRef(locals.user.id, params.ref);
		const { detail } = await getMessage(account, locator);
		return json(await getThread(account, locator, detail));
	} catch (e) {
		if (e instanceof MailError) error(e.status, e.message);
		if (e instanceof InvalidMessageRefError) error(400, e.message);
		throw e;
	}
};
