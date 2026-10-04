import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { mailAccount, mcpAccountAccess } from '../db/schema';
import { ACCESS_LEVELS, ACCESS_LEVEL_LABELS, type AccessLevel } from '../../mail-types';
import { decodeMessageRef, type MessageLocator } from '../mail/message-ref';
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

export interface Grant {
	account: MailAccount;
	level: AccessLevel;
}

const SETTINGS_HINT = 'The user can change this at Settings → Connected apps in the webmail.';

/** The mail accounts one OAuth client may use, checked on every tool call. */
export class McpAccess {
	constructor(private readonly grants: Grant[]) {}

	static async load(userId: string, clientId: string): Promise<McpAccess> {
		const rows = await db
			.select({ account: mailAccount, level: mcpAccountAccess.level })
			.from(mcpAccountAccess)
			.innerJoin(mailAccount, eq(mailAccount.id, mcpAccountAccess.accountId))
			.where(and(eq(mcpAccountAccess.userId, userId), eq(mcpAccountAccess.clientId, clientId)))
			.orderBy(mailAccount.sortOrder, mailAccount.createdAt);
		return new McpAccess(rows);
	}

	list(): Grant[] {
		return this.grants;
	}

	/** Granted accounts at or above a level. */
	accounts(level: AccessLevel = 'read'): MailAccount[] {
		return this.grants.filter((g) => levelAllows(g.level, level)).map((g) => g.account);
	}

	/** An account by ID or email address, if granted at the required level. */
	require(accountIdOrEmail: string, level: AccessLevel): MailAccount {
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
		return grant.account;
	}

	requireRef(ref: string, level: AccessLevel): { account: MailAccount; locator: MessageLocator } {
		const locator = decodeMessageRef(ref);
		return { account: this.require(locator.accountId, level), locator };
	}
}
