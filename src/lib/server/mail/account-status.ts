import { eq } from 'drizzle-orm';
import { db } from '../db';
import { mailAccount } from '../db/schema';
import type { MailAccount } from './types';

/** Records an account-level failure (sign-in rejected, server unreachable) shown in Settings. */
export async function recordAccountError(account: MailAccount, message: string): Promise<void> {
	await db.update(mailAccount).set({ lastError: message }).where(eq(mailAccount.id, account.id));
	account.lastError = message;
}

/** Clears a recorded failure once the account works again. */
export async function clearAccountError(account: MailAccount): Promise<void> {
	if (!account.lastError) return;
	await db.update(mailAccount).set({ lastError: null }).where(eq(mailAccount.id, account.id));
	account.lastError = null;
}
