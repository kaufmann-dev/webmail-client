import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { mailAccount, mcpAccountAccess } from '../db/schema';
import {
	ACCESS_LEVELS,
	ACCESS_LEVEL_LABELS,
	storedMaxAgeDays,
	type AccessLevel,
	type AccountGrant,
	type MessageSummary
} from '../../mail-types';
import { decodeMessageRef, type MessageLocator } from '../mail/message-ref';
import { getMessage, receivedDates, type ReadMessage } from '../mail/messages';
import type { MailAccount } from '../mail/types';

export class McpAccessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'McpAccessError';
	}
}

/** Levels are cumulative: `send` includes `organize`, which includes `read`. */
export function levelAllows(granted: AccessLevel, required: AccessLevel): boolean {
	return ACCESS_LEVELS.indexOf(granted) >= ACCESS_LEVELS.indexOf(required);
}

export type Grant = { account: MailAccount } & AccountGrant;

/** How access checks read messages; tests substitute their own. */
export interface MessageSource {
	read(account: MailAccount, locator: MessageLocator): Promise<ReadMessage>;
	/** Received dates by ref; messages that no longer exist are missing. */
	receivedDates(account: MailAccount, locators: MessageLocator[]): Promise<Map<string, string>>;
}

const MAIL: MessageSource = { read: getMessage, receivedDates };

const SETTINGS_HINT = 'The user can change this at Settings → Connected apps in the webmail.';
const DAY_MS = 24 * 60 * 60_000;

/**
 * The mail accounts one OAuth client may use, checked on every tool call: the access level, the
 * time window (only messages received in the last N days), and whether attachments may be read.
 * Every tool that touches existing messages goes through `requireMessage` or `requireMessages`.
 */
export class McpAccess {
	constructor(
		private readonly grants: Grant[],
		private readonly source: MessageSource = MAIL
	) {}

	static async load(userId: string, clientId: string): Promise<McpAccess> {
		const rows = await db
			.select({
				account: mailAccount,
				level: mcpAccountAccess.level,
				maxAgeDays: mcpAccountAccess.maxAgeDays,
				allowAttachments: mcpAccountAccess.allowAttachments
			})
			.from(mcpAccountAccess)
			.innerJoin(mailAccount, eq(mailAccount.id, mcpAccountAccess.accountId))
			.where(and(eq(mcpAccountAccess.userId, userId), eq(mcpAccountAccess.clientId, clientId)))
			.orderBy(mailAccount.sortOrder, mailAccount.createdAt);
		return new McpAccess(
			rows.map((row) => ({
				...row,
				maxAgeDays: storedMaxAgeDays(row.maxAgeDays)
			}))
		);
	}

	list(): Grant[] {
		return this.grants;
	}

	/** Granted accounts at or above a level. */
	accounts(level: AccessLevel = 'read'): MailAccount[] {
		return this.grants.filter((g) => levelAllows(g.level, level)).map((g) => g.account);
	}

	/** The grant for an account by ID or email address, if it has the required level. */
	grant(accountIdOrEmail: string, level: AccessLevel): Grant {
		const key = accountIdOrEmail.trim().toLowerCase();
		const grant = this.grants.find(
			(g) => g.account.id === accountIdOrEmail || g.account.email.toLowerCase() === key
		);
		if (!grant) {
			throw new McpAccessError(
				`No access to mail account "${accountIdOrEmail}". Call list_accounts for the accounts this connection may use. ${SETTINGS_HINT}`
			);
		}
		if (!levelAllows(grant.level, level)) {
			throw new McpAccessError(
				`This connection has "${ACCESS_LEVEL_LABELS[grant.level]}" access to ${grant.account.email}; ` +
					`this action needs "${ACCESS_LEVEL_LABELS[level]}". ${SETTINGS_HINT}`
			);
		}
		return grant;
	}

	/** An account by ID or email address, if granted at the required level. */
	require(accountIdOrEmail: string, level: AccessLevel): MailAccount {
		return this.grant(accountIdOrEmail, level).account;
	}

	/** The oldest received time the grant allows, or null without a time window. */
	cutoff(grant: Grant): Date | null {
		return grant.maxAgeDays === null ? null : new Date(Date.now() - grant.maxAgeDays * DAY_MS);
	}

	inWindow(grant: Grant, date: string): boolean {
		const cutoff = this.cutoff(grant);
		return !cutoff || Date.parse(date) >= cutoff.getTime();
	}

	private assertInWindow(grant: Grant, date: string): void {
		if (this.inWindow(grant, date)) return;
		throw new McpAccessError(
			`${grant.account.email} only allows this connection to access messages from the last ` +
				`${grant.maxAgeDays} days. ${SETTINGS_HINT}`
		);
	}

	/** Refuses access to attachments when the grant withholds them. */
	assertAttachments(grant: Grant, hint = ''): void {
		if (grant.allowAttachments) return;
		throw new McpAccessError(
			`${grant.account.email} does not allow this connection to read attachments.${hint ? ` ${hint}` : ''} ${SETTINGS_HINT}`
		);
	}

	/** Per account ID, the time windows of these accounts, for `listMessages`. */
	notBefore(accounts: MailAccount[]): Map<string, Date> {
		const windows = new Map<string, Date>();
		for (const account of accounts) {
			const grant = this.grants.find((g) => g.account.id === account.id);
			const cutoff = grant && this.cutoff(grant);
			if (cutoff) windows.set(account.id, cutoff);
		}
		return windows;
	}

	/** The messages within their account's time window. */
	visible<T extends MessageSummary>(messages: T[]): T[] {
		return messages.filter((message) => {
			const grant = this.grants.find((g) => g.account.id === message.accountId);
			return grant !== undefined && this.inWindow(grant, message.date);
		});
	}

	/**
	 * Resolves and reads one message the tool may use: the account's level, then (with
	 * `attachments`) the attachment rule, then the time window against its received date.
	 */
	async requireMessage(
		ref: string,
		level: AccessLevel,
		options: { attachments?: boolean; attachmentsHint?: string } = {}
	): Promise<{ grant: Grant; account: MailAccount; locator: MessageLocator; read: ReadMessage }> {
		const locator = decodeMessageRef(ref);
		const grant = this.grant(locator.accountId, level);
		if (options.attachments) this.assertAttachments(grant, options.attachmentsHint);
		const read = await this.source.read(grant.account, locator);
		this.assertInWindow(grant, read.detail.date);
		return { grant, account: grant.account, locator, read };
	}

	/**
	 * Checks several messages for a bulk action: the level of each account, and the time window
	 * from received dates alone. Messages that no longer exist pass; the action leaves them alone.
	 */
	async requireMessages(refs: string[], level: AccessLevel): Promise<void> {
		const windowed = new Map<string, { grant: Grant; locators: MessageLocator[] }>();
		for (const ref of refs) {
			const locator = decodeMessageRef(ref);
			const grant = this.grant(locator.accountId, level);
			if (grant.maxAgeDays === null) continue;
			const entry = windowed.get(grant.account.id) ?? { grant, locators: [] };
			entry.locators.push(locator);
			windowed.set(grant.account.id, entry);
		}
		for (const { grant, locators } of windowed.values()) {
			const dates = await this.source.receivedDates(grant.account, locators);
			for (const date of dates.values()) this.assertInWindow(grant, date);
		}
	}
}
