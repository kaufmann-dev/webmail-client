import { redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { startMicrosoftAuthorization } from '#lib/server/mail/microsoft.js';
import type { RequestHandler } from './$types';

const COOKIE = 'ms_connect';

/** Starts Microsoft sign-in for a mailbox; state, PKCE verifier, and address live in a short cookie. */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const email = url.searchParams.get('email')?.trim() ?? '';
	if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
		redirect(
			303,
			`/settings/accounts/new?error=${encodeURIComponent('Enter your email address.')}`
		);
	}
	const { url: authorizeUrl, state, verifier } = await startMicrosoftAuthorization(email);
	cookies.set(COOKIE, JSON.stringify({ state, verifier, email }), {
		path: '/accounts/microsoft',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: 600
	});
	redirect(303, authorizeUrl.toString());
};
