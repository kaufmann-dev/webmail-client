import { redirect } from '@sveltejs/kit';
import { auth } from '#lib/server/auth.js';
import { safeReturnTo } from '#lib/return-to.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ request, url }) => {
	const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
	// A signed query means an MCP client's authorization sent the user here; sign-in resumes it.
	const oauthRequest = url.searchParams.has('sig');
	if (!oauthRequest && (await auth.api.getSession({ headers: request.headers }))) {
		redirect(303, returnTo);
	}
	return { returnTo, oauthRequest, failed: url.searchParams.has('error') };
};
