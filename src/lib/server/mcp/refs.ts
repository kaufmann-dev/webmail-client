import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { mcpMessageRef } from '../db/schema';
import { InvalidMessageRefError } from '../mail/message-ref';

/** A short MCP ref and the message it stands for. */
export interface RefRow {
	id: string;
	accountId: string;
	/** The message's current ref from `encodeMessageRef`. */
	locator: string;
	messageId: string | null;
}

/** Where short refs are kept; tests substitute their own. */
export interface RefStore {
	/** The short ref of each locator, created where missing. */
	mint(userId: string, rows: Omit<RefRow, 'id'>[]): Promise<Map<string, string>>;
	find(userId: string, ids: string[]): Promise<RefRow[]>;
	/** Points refs at the new locators of moved messages, by old locator. */
	relocate(userId: string, moves: Map<string, string>): Promise<void>;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;

/** A random ref of 10 letters and digits (about 59 bits). */
export function newRefId(): string {
	return [...randomBytes(ID_LENGTH)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

const dbStore: RefStore = {
	async mint(userId, rows) {
		if (!rows.length) return new Map();
		const minted = await db
			.insert(mcpMessageRef)
			.values(rows.map((row) => ({ ...row, id: newRefId(), userId })))
			.onConflictDoUpdate({
				target: [mcpMessageRef.userId, mcpMessageRef.locator],
				// A no-op update, so that existing rows are returned too.
				set: { userId }
			})
			.returning({ id: mcpMessageRef.id, locator: mcpMessageRef.locator });
		return new Map(minted.map((row) => [row.locator, row.id]));
	},
	async find(userId, ids) {
		if (!ids.length) return [];
		return db
			.select({
				id: mcpMessageRef.id,
				accountId: mcpMessageRef.accountId,
				locator: mcpMessageRef.locator,
				messageId: mcpMessageRef.messageId
			})
			.from(mcpMessageRef)
			.where(and(eq(mcpMessageRef.userId, userId), inArray(mcpMessageRef.id, ids)));
	},
	async relocate(userId, moves) {
		if (!moves.size) return;
		await db.transaction(async (tx) => {
			const mine = eq(mcpMessageRef.userId, userId);
			// A ref already minted for the new location gives way to the older one.
			await tx
				.delete(mcpMessageRef)
				.where(and(mine, inArray(mcpMessageRef.locator, [...moves.values()])));
			for (const [from, to] of moves) {
				await tx
					.update(mcpMessageRef)
					.set({ locator: to })
					.where(and(mine, eq(mcpMessageRef.locator, from)));
			}
		});
	}
};

const UNKNOWN =
	'Unknown message_ref. Use a message_ref from list_messages, search_messages, or get_thread.';

/**
 * Short, stable message refs for one user's MCP requests. Mail-layer refs carry the folder and
 * the provider's full item ID (often over 250 characters); AI clients get 10 characters instead.
 */
export class McpRefs {
	constructor(
		private readonly userId: string,
		private readonly store: RefStore = dbStore
	) {}

	/** Short refs by mail-layer ref, created where missing. */
	async shorten(
		messages: { ref: string; accountId: string; messageId: string | null }[]
	): Promise<Map<string, string>> {
		const unique = new Map(
			messages.map((m) => [
				m.ref,
				{ accountId: m.accountId, locator: m.ref, messageId: m.messageId }
			])
		);
		return this.store.mint(this.userId, [...unique.values()]);
	}

	async resolve(id: string): Promise<RefRow> {
		const [row] = await this.store.find(this.userId, [id.trim()]);
		if (!row) throw new InvalidMessageRefError(UNKNOWN);
		return row;
	}

	/** Rows in the order of `ids`. */
	async resolveAll(ids: string[]): Promise<RefRow[]> {
		const rows = await this.store.find(this.userId, [...new Set(ids.map((id) => id.trim()))]);
		const byId = new Map(rows.map((row) => [row.id, row]));
		return ids.map((id) => {
			const row = byId.get(id.trim());
			if (!row) throw new InvalidMessageRefError(`${UNKNOWN} Unknown: ${id}`);
			return row;
		});
	}

	moved(moves: Map<string, string>): Promise<void> {
		return this.store.relocate(this.userId, moves);
	}
}
