import { ImapFlow, type MailboxObject } from 'imapflow';
import { clearAccountError, recordAccountError } from './account-status';
import { mailAuth, type MailAuth } from './credentials';
import { errorMessage, MailAuthError, MailError } from './errors';
import { PROVIDER_CONFIG, type ImapProvider } from './providers';
import type { MailAccount } from './types';

/** Just under the 30-minute idle logout of most servers, so returning to the tab finds it open. */
const IDLE_CLOSE_MS = 25 * 60_000;
/**
 * A command silent this long means a dead connection, which is closed so the next request
 * reconnects. imapflow's default is 5 minutes, all of which every request for the account would
 * spend waiting for the mailbox lock. Commands that keep receiving data are never cut off.
 */
const SOCKET_TIMEOUT_MS = 30_000;

interface PoolEntry {
	client?: ImapFlow;
	pending?: Promise<ImapFlow>;
	lastUsed: number;
}

/** One live IMAP connection per account, reused across requests and closed after idling. */
const pool = new Map<string, PoolEntry>();

export function createImapClient(provider: ImapProvider, auth: MailAuth): ImapFlow {
	const { host, port, secure } = PROVIDER_CONFIG[provider].imap;
	const client = new ImapFlow({
		host,
		port,
		secure,
		auth,
		logger: false,
		connectionTimeout: 20_000,
		greetingTimeout: 20_000,
		socketTimeout: SOCKET_TIMEOUT_MS
	});
	// Socket errors also surface as rejected commands; without a listener they would crash the process.
	client.on('error', () => {});
	return client;
}

async function connect(account: MailAccount): Promise<ImapFlow> {
	if (account.provider === 'exchange') throw new Error('Exchange accounts do not use IMAP.');
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
	if (accountLevel) await recordAccountError(account, mailError.message);
	return mailError;
}

/** Runs IMAP work on the account's connection, clearing a recorded error once it works again. */
export async function withClient<T>(
	account: MailAccount,
	fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
	try {
		const result = await fn(await getClient(account));
		await clearAccountError(account);
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
	return withClient(account, async (pooled) => {
		let client = pooled;
		const lockOn = (c: ImapFlow) => c.getMailboxLock(path, { acquireTimeout: 60_000 });
		const lock = await lockOn(client).catch(async (error: { code?: string }) => {
			// The connection closed while this waited (e.g. a stuck command timed out) and nothing
			// ran yet, so start again on a new one.
			if (error?.code !== 'NoConnection') throw error;
			client = await getClient(account);
			return lockOn(client);
		});
		try {
			return await fn(client, client.mailbox as MailboxObject);
		} finally {
			lock.release();
		}
	});
}
