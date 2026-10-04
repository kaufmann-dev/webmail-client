import { redirect } from '@sveltejs/kit';
import { upsertMicrosoftAccount } from '#lib/server/mail/accounts.js';
import { errorMessage } from '#lib/server/mail/errors.js';
import { completeMicrosoftAuthorization } from '#lib/server/mail/microsoft.js';
import type { RequestHandler } from './$types';

const COOKIE = 'ms_connect';

function fail(message: string): never {
	redirect(303, `/settings/accounts/new?error=${encodeURIComponent(message)}`);
}

/** Finishes Microsoft sign-in, verifies the mailbox over IMAP and SMTP, and saves the account. */
export const GET: RequestHandler = async ({ url, cookies, locals }) => {
	const raw = cookies.get(COOKIE);
	cookies.delete(COOKIE, { path: '/accounts/microsoft' });
	let pending: { state: string; verifier: string; email: string };
	try {
		pending = JSON.parse(raw ?? '');
	} catch {
		fail('The Microsoft sign-in expired. Start again.');
	}
	try {
		const tokens = await completeMicrosoftAuthorization(url, pending.state, pending.verifier);
		if (!tokens.refreshToken) throw new Error('Microsoft returned no refresh token.');
		await upsertMicrosoftAccount(locals.user.id, pending.email, {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt
		});
	} catch (error) {
		fail(errorMessage(error));
	}
	redirect(303, '/settings/accounts?connected=1');
};
