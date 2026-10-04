import { error } from '@sveltejs/kit';
import { MailError } from '#lib/server/mail/errors.js';
import { InvalidMessageRefError } from '#lib/server/mail/message-ref.js';
import { getAttachment, resolveRef } from '#lib/server/mail/messages.js';
import type { RequestHandler } from './$types';

/** Downloads an attachment; never rendered inline, so attachment HTML cannot run in the app origin. */
export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const { account, locator } = await resolveRef(locals.user.id, params.ref);
		const file = await getAttachment(account, locator, params.part);
		return new Response(new Uint8Array(file.content), {
			headers: {
				'content-type': 'application/octet-stream',
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
				'content-length': String(file.content.length),
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store'
			}
		});
	} catch (e) {
		if (e instanceof MailError) error(e.status, e.message);
		if (e instanceof InvalidMessageRefError) error(400, e.message);
		throw e;
	}
};
