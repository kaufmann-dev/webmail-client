import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { mailAccount } from '../db/schema';
import {
	ACCOUNT_COLORS,
	type AccountColor,
	type AccountSummary,
	type Provider
} from '../../mail-types';
import { cacheAccessToken, forgetAccessToken, sealSecret, type MailAuth } from './credentials';
import { errorMessage, MailAuthError, MailError } from './errors';
import { invalidateFolders } from './folders';
import { createImapClient, dropClient } from './imap';
import { createSmtpTransport } from './smtp';
import type { MailAccount } from './types';

export function toSummary(account: MailAccount): AccountSummary {
	return {
		id: account.id,
		provider: account.provider,
		email: account.email,
		displayName: account.displayName,
		label: account.label,
		color: account.color,
		signature: account.signature,
		lastError: account.lastError
	};
}

export function listAccounts(userId: string): Promise<MailAccount[]> {
	return db
		.select()
		.from(mailAccount)
		.where(eq(mailAccount.userId, userId))
		.orderBy(asc(mailAccount.sortOrder), asc(mailAccount.createdAt));
}

export async function getAccount(userId: string, accountId: string): Promise<MailAccount> {
	const [account] = await db
		.select()
		.from(mailAccount)
		.where(and(eq(mailAccount.userId, userId), eq(mailAccount.id, accountId)));
	if (!account) throw new MailError('Mail account not found.', 404);
	return account;
}

/** Logs in over IMAP and verifies SMTP, so broken credentials are never saved. */
export async function testConnection(provider: Provider, auth: MailAuth): Promise<void> {
	const imap = createImapClient(provider, auth);
	try {
		await imap.connect();
		await imap.logout();
	} catch (error) {
		imap.close();
		const failed = (error as { authenticationFailed?: boolean }).authenticationFailed;
		const rejected =
			provider === 'microsoft'
				? 'IMAP sign-in was rejected. Check that the address belongs to the Microsoft account you signed in with and that IMAP is enabled for the mailbox.'
				: 'IMAP sign-in was rejected. Check the address and password (Gmail needs an app password).';
		throw new MailAuthError(
			failed ? rejected : `Cannot connect to the IMAP server: ${errorMessage(error)}`
		);
	}
	const smtp = createSmtpTransport(provider, auth);
	try {
		await smtp.verify();
	} catch (error) {
		throw new MailAuthError(`SMTP sign-in failed: ${errorMessage(error)}`);
	} finally {
		smtp.close();
	}
}

async function nextPlacement(userId: string): Promise<{ sortOrder: number; color: AccountColor }> {
	const existing = await listAccounts(userId);
	const used = new Set(existing.map((a) => a.color));
	return {
		sortOrder: existing.reduce((max, a) => Math.max(max, a.sortOrder + 1), 0),
		color: ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[existing.length % 8]
	};
}

export async function createPasswordAccount(
	userId: string,
	input: {
		provider: Exclude<Provider, 'microsoft'>;
		email: string;
		password: string;
		displayName: string;
	}
): Promise<MailAccount> {
	const email = input.email.trim();
	await testConnection(input.provider, { user: email, pass: input.password });
	const placement = await nextPlacement(userId);
	try {
		const [account] = await db
			.insert(mailAccount)
			.values({
				userId,
				provider: input.provider,
				email,
				displayName: input.displayName.trim() || email,
				label: email,
				secret: sealSecret(input.password),
				...placement
			})
			.returning();
		return account;
	} catch (error) {
		if ((error as { code?: string }).code === '23505') {
			throw new MailError(`${email} is already connected.`, 409);
		}
		throw error;
	}
}

/** Creates or reconnects a Microsoft 365 account after a successful OAuth sign-in. */
export async function upsertMicrosoftAccount(
	userId: string,
	email: string,
	tokens: { accessToken: string; refreshToken: string; expiresAt: number }
): Promise<MailAccount> {
	await testConnection('microsoft', { user: email, accessToken: tokens.accessToken });
	const secret = sealSecret(tokens.refreshToken);
	const [existing] = await db
		.select()
		.from(mailAccount)
		.where(and(eq(mailAccount.userId, userId), eq(mailAccount.email, email)));
	let account: MailAccount;
	if (existing) {
		if (existing.provider !== 'microsoft') {
			throw new MailError(`${email} is already connected as a different account type.`, 409);
		}
		[account] = await db
			.update(mailAccount)
			.set({ secret, lastError: null })
			.where(eq(mailAccount.id, existing.id))
			.returning();
		dropClient(account.id);
	} else {
		const placement = await nextPlacement(userId);
		[account] = await db
			.insert(mailAccount)
			.values({
				userId,
				provider: 'microsoft',
				email,
				displayName: email,
				label: email,
				secret,
				...placement
			})
			.returning();
	}
	cacheAccessToken(account.id, tokens.accessToken, tokens.expiresAt);
	return account;
}

export async function updateAccount(
	userId: string,
	accountId: string,
	input: {
		label: string;
		displayName: string;
		color: AccountColor;
		signature: string;
		password?: string;
	}
): Promise<void> {
	const account = await getAccount(userId, accountId);
	const changes: Partial<MailAccount> = {
		label: input.label.trim() || account.email,
		displayName: input.displayName.trim() || account.email,
		color: input.color,
		signature: input.signature.trim() ? input.signature.replace(/\s+$/, '') : null
	};
	if (input.password) {
		if (account.provider === 'microsoft') {
			throw new MailError('Microsoft accounts reconnect through Microsoft sign-in.', 400);
		}
		await testConnection(account.provider, { user: account.email, pass: input.password });
		changes.secret = sealSecret(input.password);
		changes.lastError = null;
	}
	await db.update(mailAccount).set(changes).where(eq(mailAccount.id, account.id));
	if (input.password) dropClient(account.id);
}

export async function deleteAccount(userId: string, accountId: string): Promise<void> {
	const account = await getAccount(userId, accountId);
	await db.delete(mailAccount).where(eq(mailAccount.id, account.id));
	dropClient(account.id);
	forgetAccessToken(account.id);
	invalidateFolders(account.id);
}

/** Swaps an account with its neighbour in the sidebar order. */
export async function moveAccount(userId: string, accountId: string, direction: -1 | 1) {
	const accounts = await listAccounts(userId);
	const index = accounts.findIndex((a) => a.id === accountId);
	const other = accounts[index + direction];
	if (index < 0 || !other) return;
	await db.transaction(async (tx) => {
		const ordered = accounts.map((a, i) => ({ id: a.id, sortOrder: i }));
		[ordered[index].sortOrder, ordered[index + direction].sortOrder] = [index + direction, index];
		for (const row of ordered) {
			await tx
				.update(mailAccount)
				.set({ sortOrder: row.sortOrder })
				.where(eq(mailAccount.id, row.id));
		}
	});
}
