import * as env from '$app/env/private';

const REQUIRED = [
	'DATABASE_URL',
	'ORIGIN',
	'BETTER_AUTH_SECRET',
	'POCKET_ID_ISSUER',
	'POCKET_ID_CLIENT_ID',
	'POCKET_ID_CLIENT_SECRET',
	'CREDENTIALS_KEY'
] as const;

/** Fails fast at server start. Not called during the build, which has no runtime secrets. */
export function assertEnv(): void {
	const missing = REQUIRED.filter((name) => !env[name]);
	if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
	if (Buffer.from(env.CREDENTIALS_KEY ?? '', 'base64').length !== 32) {
		throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');
	}
}

/** Microsoft 365 mailboxes can be connected only when the Entra app is configured. */
export function microsoftConfigured(): boolean {
	return Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
}
