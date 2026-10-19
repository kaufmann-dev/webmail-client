import { error, json } from '@sveltejs/kit';
import { MailError } from '#lib/server/mail/errors.js';
import { transfers } from '#lib/server/mcp/transfers.js';
import type { RequestHandler } from './$types';

/** Receives a file for an upload from `create_attachment_upload`; the token is the credential. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const content = Buffer.from(await request.arrayBuffer());
	try {
		transfers.storeUpload(params.token, content);
	} catch (e) {
		if (e instanceof MailError) error(e.status, e.message);
		throw e;
	}
	return json({ upload_id: params.token, size: content.length }, { status: 201 });
};
