import { ImapFlow, type MailboxObject } from 'imapflow';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { mailAccount } from '../db/schema';
import { mailAuth, type MailAuth } from './credentials';
import { errorMessage, MailAuthError, MailError } from './errors';
import { PROVIDER_CONFIG } from './providers';
import type { MailAccount } from './types';
import type { Provider } from '../../mail-types';

const IDLE_CLOSE_MS = 5 * 60_000;

interface PoolEntry {
	client?: ImapFlow;
	pending?: Promise<ImapFlow>;
	lastUsed: number;
}

/** One live IMAP connection per account, reused across requests and closed after idling. */
const pool = new Map<string, PoolEntry>();

export function createImapClient(provider: Provider, auth: MailAuth): ImapFlow {
	const { host, port, secure } = PROVIDER_CONFIG[provider].imap;
	const client = new ImapFlow({
		host,
		port,
		secure,
		auth,
		logger: false,
		connectionTimeout: 20_000,
		greetingTimeout: 20_000
	});
	// Socket errors also surface as rejected commands; without a listener they would crash the process.
	client.on('error', () => {});
	return client;
}

async function connect(account: MailAccount): Promise<ImapFlow> {
	const client = createImapClient(account.provider, await mailAuth(account));
	client.on('close', () => {
		if (pool.get(account.id)?.client === client) pool.delete(account.id);
	});
	await client.connect();
	return client;
}

async function getClient(account: MailAccount): Promise<ImapFlow> {
	const entry = pool.get(account.id);
	if (entry?.client?.usable) {
		entry.lastUsed = Date.now();
		return entry.client;
	}
	if (entry?.pending) return entry.pending;
	if (entry?.client) entry.client.close();
	const pending = connect(account).then(
		(client) => {
			pool.set(account.id, { client, lastUsed: Date.now() });
			return client;
		},
		(error) => {
			pool.delete(account.id);
			throw error;
		}
	);
	pool.set(account.id, { pending, lastUsed: Date.now() });
	return pending;
}

/** Closes an account's connection, e.g. after its credentials changed or it was removed. */
export function dropClient(accountId: string): void {
	const entry = pool.get(accountId);
	pool.delete(accountId);
	entry?.client?.close();
}

let reaper: ReturnType<typeof setInterval> | undefined;

export function startImapReaper(): void {
	reaper ??= setInterval(() => {
		const cutoff = Date.now() - IDLE_CLOSE_MS;
		for (const [id, entry] of pool) {
			if (entry.client && entry.lastUsed < cutoff) {
				pool.delete(id);
				entry.client.logout().catch(() => entry.client?.close());
			}
		}
	}, 60_000);
	reaper.unref();
	process.on('sveltekit:shutdown', () => {
		for (const entry of pool.values()) entry.client?.close();
	});
}

interface ImapErrorShape {
	authenticationFailed?: boolean;
	responseText?: string;
	serverResponseCode?: string;
	code?: string;
}

/** Converts IMAP failures into user-facing errors and records account-level ones. */
async function toMailError(account: MailAccount, error: unknown): Promise<MailError> {
	if (error instanceof MailError) return error;
	const shape = (error ?? {}) as ImapErrorShape;
	let mailError: MailError;
	let accountLevel = false;
	if (shape.authenticationFailed) {
		accountLevel = true;
		mailError = new MailAuthError(
			`${account.email}: sign-in rejected${shape.responseText ? ` (${shape.responseText})` : ''}. ` +
				(account.provider === 'microsoft' ? 'Reconnect the account.' : 'Update the password.')
		);
	} else if (shape.serverResponseCode === 'NONEXISTENT') {
		mailError = new MailError('That folder does not exist.', 404);
	} else if (
		shape.code &&
		/^(E[A-Z]+|NoConnection|ConnectionTimeout|GreetingTimeout)$/.test(shape.code)
	) {
		accountLevel = true;
		mailError = new MailError(
			`${account.email}: cannot reach the mail server (${shape.code}).`,
			502
		);
	} else {
		mailError = new MailError(
			`${account.email}: ${shape.responseText ?? errorMessage(error)}`,
			502
		);
	}
	if (accountLevel) {
		await db
			.update(mailAccount)
			.set({ lastError: mailError.message })
			.where(eq(mailAccount.id, account.id));
		account.lastError = mailError.message;
	}
	return mailError;
}

/** Runs IMAP work on the account's connection, clearing a recorded error once it works again. */
export async function withClient<T>(
	account: MailAccount,
	fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
	try {
		const result = await fn(await getClient(account));
		if (account.lastError) {
			await db.update(mailAccount).set({ lastError: null }).where(eq(mailAccount.id, account.id));
			account.lastError = null;
		}
		return result;
	} catch (error) {
		throw await toMailError(account, error);
	}
}

/** Selects a mailbox for the duration of `fn`; other work on the account waits for the lock. */
export function withMailbox<T>(
	account: MailAccount,
	path: string,
	fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>
): Promise<T> {
	return withClient(account, async (client) => {
		const lock = await client.getMailboxLock(path, { acquireTimeout: 60_000 });
		try {
			return await fn(client, client.mailbox as MailboxObject);
		} finally {
			lock.release();
		}
	});
}
