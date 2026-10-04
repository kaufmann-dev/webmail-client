import * as oauth from 'oauth4webapi';
import { MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, ORIGIN } from '$app/env/private';
import { MailAuthError, MailError } from './errors';

/** Work and school accounts from any Entra tenant (for example a university's Microsoft 365). */
const TENANT = 'organizations';
const BASE = `https://login.microsoftonline.com/${TENANT}`;

const authorizationServer: oauth.AuthorizationServer = {
	issuer: `${BASE}/v2.0`,
	authorization_endpoint: `${BASE}/oauth2/v2.0/authorize`,
	token_endpoint: `${BASE}/oauth2/v2.0/token`
};

/**
 * Mailbox access only, no `openid`: the user names the address, and the IMAP XOAUTH2 login proves
 * the token belongs to it. This also avoids Entra's templated multi-tenant ID-token issuer.
 */
const SCOPES = [
	'offline_access',
	'https://outlook.office.com/IMAP.AccessAsUser.All',
	'https://outlook.office.com/SMTP.Send'
].join(' ');

export interface MicrosoftTokens {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number;
}

function client(): { client: oauth.Client; auth: oauth.ClientAuth } {
	if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
		throw new MailError('Microsoft accounts are not configured on this server.', 400);
	}
	return {
		client: { client_id: MICROSOFT_CLIENT_ID },
		auth: oauth.ClientSecretPost(MICROSOFT_CLIENT_SECRET)
	};
}

export function microsoftRedirectUri(): string {
	return `${(ORIGIN ?? '').replace(/\/$/, '')}/accounts/microsoft/callback`;
}

export async function startMicrosoftAuthorization(email: string) {
	const { client: c } = client();
	const state = oauth.generateRandomState();
	const verifier = oauth.generateRandomCodeVerifier();
	const url = new URL(authorizationServer.authorization_endpoint!);
	url.search = new URLSearchParams({
		client_id: c.client_id,
		response_type: 'code',
		redirect_uri: microsoftRedirectUri(),
		scope: SCOPES,
		state,
		code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
		code_challenge_method: 'S256',
		login_hint: email,
		prompt: 'select_account'
	}).toString();
	return { url, state, verifier };
}

function toTokens(result: oauth.TokenEndpointResponse): MicrosoftTokens {
	return {
		accessToken: result.access_token,
		refreshToken: result.refresh_token ?? null,
		expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000
	};
}

export async function completeMicrosoftAuthorization(
	currentUrl: URL,
	expectedState: string,
	verifier: string
): Promise<MicrosoftTokens> {
	const { client: c, auth } = client();
	let params: URLSearchParams;
	try {
		params = oauth.validateAuthResponse(authorizationServer, c, currentUrl, expectedState);
	} catch (error) {
		const description =
			error instanceof oauth.AuthorizationResponseError
				? (error.error_description ?? error.error)
				: 'The sign-in response was invalid.';
		throw new MailAuthError(`Microsoft sign-in failed: ${description}`);
	}
	const response = await oauth.authorizationCodeGrantRequest(
		authorizationServer,
		c,
		auth,
		params,
		microsoftRedirectUri(),
		verifier
	);
	try {
		return toTokens(await oauth.processAuthorizationCodeResponse(authorizationServer, c, response));
	} catch (error) {
		throw new MailAuthError(`Microsoft sign-in failed: ${describe(error)}`);
	}
}

export async function refreshMicrosoftToken(refreshToken: string): Promise<MicrosoftTokens> {
	const { client: c, auth } = client();
	const response = await oauth.refreshTokenGrantRequest(authorizationServer, c, auth, refreshToken);
	try {
		return toTokens(await oauth.processRefreshTokenResponse(authorizationServer, c, response));
	} catch (error) {
		throw new MailAuthError(
			`Microsoft sign-in expired or was revoked (${describe(error)}). Reconnect the account.`
		);
	}
}

function describe(error: unknown): string {
	if (error instanceof oauth.ResponseBodyError) return error.error_description ?? error.error;
	return error instanceof Error ? error.message : String(error);
}
