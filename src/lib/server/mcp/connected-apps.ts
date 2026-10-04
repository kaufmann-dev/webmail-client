import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import {
	mailAccount,
	mcpAccountAccess,
	oauthAccessToken,
	oauthClient,
	oauthConsent,
	oauthRefreshToken
} from '../db/schema';
import type { AccessLevel } from '../../mail-types';

export interface ConnectedApp {
	clientId: string;
	name: string;
	uri: string | null;
	grantedAt: Date;
	access: Record<string, AccessLevel>;
}

/** MCP clients the user has authorized, with the mail accounts each may use. */
export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
	const [apps, grants] = await Promise.all([
		db
			.select({
				clientId: oauthConsent.clientId,
				name: oauthClient.name,
				uri: oauthClient.uri,
				grantedAt: oauthConsent.updatedAt
			})
			.from(oauthConsent)
			.innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
			.where(eq(oauthConsent.userId, userId))
			.orderBy(asc(oauthClient.name)),
		accessFor(userId)
	]);
	return apps.map((app) => ({
		...app,
		name: app.name ?? app.clientId,
		access: Object.fromEntries(
			grants.filter((g) => g.clientId === app.clientId).map((g) => [g.accountId, g.level])
		)
	}));
}

function accessFor(userId: string, clientId?: string) {
	return db
		.select({
			clientId: mcpAccountAccess.clientId,
			accountId: mcpAccountAccess.accountId,
			level: mcpAccountAccess.level
		})
		.from(mcpAccountAccess)
		.where(
			clientId
				? and(eq(mcpAccountAccess.userId, userId), eq(mcpAccountAccess.clientId, clientId))
				: eq(mcpAccountAccess.userId, userId)
		);
}

export async function getClientAccess(userId: string, clientId: string) {
	const rows = await accessFor(userId, clientId);
	return Object.fromEntries(rows.map((r) => [r.accountId, r.level])) as Record<string, AccessLevel>;
}

/** Replaces which accounts a client may use. Only the user's own accounts are accepted. */
export async function setClientAccess(
	userId: string,
	clientId: string,
	grants: { accountId: string; level: AccessLevel }[]
): Promise<void> {
	const owned = new Set(
		(
			await db
				.select({ id: mailAccount.id })
				.from(mailAccount)
				.where(eq(mailAccount.userId, userId))
		).map((a) => a.id)
	);
	const rows = grants
		.filter((g) => owned.has(g.accountId))
		.map((g) => ({ userId, clientId, accountId: g.accountId, level: g.level }));
	await db.transaction(async (tx) => {
		await tx
			.delete(mcpAccountAccess)
			.where(and(eq(mcpAccountAccess.userId, userId), eq(mcpAccountAccess.clientId, clientId)));
		if (rows.length) await tx.insert(mcpAccountAccess).values(rows);
	});
}

/**
 * Removes the consent and account grants and revokes refresh tokens, so the client must authorize
 * again. Already-issued JWT access tokens find no grants and can no longer reach any mail.
 */
export async function revokeConnectedApp(userId: string, clientId: string): Promise<void> {
	await db.transaction(async (tx) => {
		const owned = (
			table: typeof oauthConsent | typeof oauthRefreshToken | typeof oauthAccessToken
		) => and(eq(table.userId, userId), eq(table.clientId, clientId));
		await tx.delete(oauthConsent).where(owned(oauthConsent));
		await tx
			.update(oauthRefreshToken)
			.set({ revoked: new Date() })
			.where(and(owned(oauthRefreshToken), isNull(oauthRefreshToken.revoked)));
		await tx.delete(oauthAccessToken).where(owned(oauthAccessToken));
		await tx
			.delete(mcpAccountAccess)
			.where(and(eq(mcpAccountAccess.userId, userId), eq(mcpAccountAccess.clientId, clientId)));
	});
}

/** Parses `access:<accountId>` form fields (value: read | organize | send | none). */
export function grantsFromForm(form: FormData): { accountId: string; level: AccessLevel }[] {
	const grants: { accountId: string; level: AccessLevel }[] = [];
	for (const [key, value] of form.entries()) {
		if (!key.startsWith('access:')) continue;
		if (value === 'read' || value === 'organize' || value === 'send') {
			grants.push({ accountId: key.slice('access:'.length), level: value });
		}
	}
	return grants;
}
