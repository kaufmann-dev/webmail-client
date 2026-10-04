import {
	index,
	integer,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique
} from 'drizzle-orm/pg-core';
import { oauthClient, user } from './auth-schema';
import { ACCOUNT_COLORS, ACCESS_LEVELS, PROVIDERS } from '../../mail-types';

export * from './auth-schema';

export const providerEnum = pgEnum('mail_provider', PROVIDERS);
export const accountColorEnum = pgEnum('account_color', ACCOUNT_COLORS);
export const accessLevelEnum = pgEnum('mcp_access_level', ACCESS_LEVELS);

/** A connected mailbox. `secret` holds the encrypted password (IMAP/SMTP) or OAuth refresh token. */
export const mailAccount = pgTable(
	'mail_account',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		provider: providerEnum('provider').notNull(),
		email: text('email').notNull(),
		displayName: text('display_name').notNull(),
		label: text('label').notNull(),
		color: accountColorEnum('color').notNull(),
		signature: text('signature'),
		sortOrder: integer('sort_order').notNull().default(0),
		secret: text('secret').notNull(),
		lastError: text('last_error'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique('mail_account_user_email_uq').on(table.userId, table.email)]
);

/** Which mail accounts an MCP client may use, and at which level. Chosen on the consent screen. */
export const mcpAccountAccess = pgTable(
	'mcp_account_access',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: 'cascade' }),
		accountId: text('account_id')
			.notNull()
			.references(() => mailAccount.id, { onDelete: 'cascade' }),
		level: accessLevelEnum('level').notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [
		primaryKey({ columns: [table.clientId, table.accountId] }),
		index('mcp_account_access_user_client_idx').on(table.userId, table.clientId)
	]
);
