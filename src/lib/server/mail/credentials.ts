import { eq } from 'drizzle-orm';
import { CREDENTIALS_KEY } from '$app/env/private';
import { db } from '../db';
import { mailAccount } from '../db/schema';
import { decryptSecret, encryptSecret } from '../crypto';
import { MailAuthError } from './errors';
import { refreshMicrosoftToken } from './microsoft';
import { PROVIDER_CONFIG } from './providers';
import type { MailAccount } from './types';

/** IMAP/SMTP login: a password, or an OAuth access token for XOAUTH2. */
export type MailAuth = { user: string; pass: string } | { user: string; accessToken: string };

export function sealSecret(secret: string): string {
	return encryptSecret(secret, CREDENTIALS_KEY ?? '');
}

export function openSecret(account: Pick<MailAccount, 'secret'>): string {
	return decryptSecret(account.secret, CREDENTIALS_KEY ?? '');
}

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export function cacheAccessToken(accountId: string, token: string, expiresAt: number): void {
	accessTokens.set(accountId, { token, expiresAt });
}

export function forgetAccessToken(accountId: string): void {
	accessTokens.delete(accountId);
}

/** Access tokens are reused until a minute before expiry; rotated refresh tokens are persisted. */
async function microsoftAccessToken(account: MailAccount): Promise<string> {
	const cached = accessTokens.get(account.id);
	if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
	try {
		const tokens = await refreshMicrosoftToken(openSecret(account));
		cacheAccessToken(account.id, tokens.accessToken, tokens.expiresAt);
		if (tokens.refreshToken) {
			const secret = sealSecret(tokens.refreshToken);
			await db.update(mailAccount).set({ secret }).where(eq(mailAccount.id, account.id));
			account.secret = secret;
		}
		return tokens.accessToken;
	} catch (error) {
		if (error instanceof MailAuthError) {
			await db
				.update(mailAccount)
				.set({ lastError: error.message })
				.where(eq(mailAccount.id, account.id));
		}
		throw error;
	}
}

export async function mailAuth(account: MailAccount): Promise<MailAuth> {
	if (PROVIDER_CONFIG[account.provider].auth === 'oauth') {
		return { user: account.email, accessToken: await microsoftAccessToken(account) };
	}
	return { user: account.email, pass: openSecret(account) };
}
