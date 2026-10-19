import { error } from '@sveltejs/kit';
import { MailError } from '#lib/server/mail/errors.js';
import { getAttachment } from '#lib/server/mail/messages.js';
import { McpAccess, McpAccessError } from '#lib/server/mcp/access.js';
import { transfers } from '#lib/server/mcp/transfers.js';
import type { RequestHandler } from './$types';

/**
 * Downloads an attachment through a link from `get_attachment`. The token is the credential; the
 * client's grants are checked again, so revoking or narrowing access applies to open links too.
 */
export const GET: RequestHandler = async ({ params }) => {
	const download = transfers.resolveDownload(params.token);
	if (!download) error(404, 'This download link is unknown or has expired.');
	try {
		const access = await McpAccess.load(download.userId, download.clientId);
		const { account, locator } = await access.requireMessage(download.ref, 'read', {
			attachments: true
		});
		const file = await getAttachment(account, locator, download.partId);
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
		if (e instanceof McpAccessError) error(403, e.message);
		if (e instanceof MailError) error(e.status, e.message);
		throw e;
	}
};
