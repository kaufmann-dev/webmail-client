import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { mcpMessageRef } from '../db/schema';
import { InvalidMessageRefError, renamedFolderRef } from '../mail/message-ref';

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
	forAccount(userId: string, accountId: string): Promise<RefRow[]>;
	/**
	 * Points refs at the new locators of moved messages, by old locator, and returns the old
	 * locators moved. A ref already at a new locator gives way, unless `keep`: then that move is
	 * skipped.
	 */
	relocate(userId: string, moves: Map<string, string>, keep?: boolean): Promise<Set<string>>;
	/** Drops the Message-ID of refs, which stops lookups by it for messages that are gone. */
	forgetMessageIds(userId: string, locators: string[]): Promise<void>;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;

/** A random ref of 10 letters and digits (about 59 bits). */
export function newRefId(): string {
	return [...randomBytes(ID_LENGTH)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

const REF_COLUMNS = {
	id: mcpMessageRef.id,
	accountId: mcpMessageRef.accountId,
	locator: mcpMessageRef.locator,
	messageId: mcpMessageRef.messageId
};

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
			.select(REF_COLUMNS)
			.from(mcpMessageRef)
			.where(and(eq(mcpMessageRef.userId, userId), inArray(mcpMessageRef.id, ids)));
	},
	async forAccount(userId, accountId) {
		return db
			.select(REF_COLUMNS)
			.from(mcpMessageRef)
			.where(and(eq(mcpMessageRef.userId, userId), eq(mcpMessageRef.accountId, accountId)));
	},
	async relocate(userId, moves, keep = false) {
		if (!moves.size) return new Set();
		return db.transaction(async (tx) => {
			const mine = eq(mcpMessageRef.userId, userId);
			const destinations = inArray(mcpMessageRef.locator, [...moves.values()]);
			let applied = moves;
			if (keep) {
				const rows = await tx
					.select({ locator: mcpMessageRef.locator })
					.from(mcpMessageRef)
					.where(and(mine, destinations));
				const taken = new Set(rows.map((row) => row.locator));
				applied = new Map([...moves].filter(([, to]) => !taken.has(to)));
			} else {
				// A ref already minted for the new location gives way to the older one.
				await tx.delete(mcpMessageRef).where(and(mine, destinations));
			}
			for (const [from, to] of applied) {
				await tx
					.update(mcpMessageRef)
					.set({ locator: to })
					.where(and(mine, eq(mcpMessageRef.locator, from)));
			}
			return new Set(applied.keys());
		});
	},
	async forgetMessageIds(userId, locators) {
		if (!locators.length) return;
		await db
			.update(mcpMessageRef)
			.set({ messageId: null })
			.where(and(eq(mcpMessageRef.userId, userId), inArray(mcpMessageRef.locator, locators)));
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

	/** Refs follow messages these tools moved. */
	async moved(moves: Map<string, string>): Promise<void> {
		await this.store.relocate(this.userId, moves);
	}

	/**
	 * Refs follow messages found again by their Message-ID after moving elsewhere, except onto a
	 * message that has its own ref: to these tools that is another message (a copy, or the same
	 * message listed again), and taking it over would silently invalidate that ref. Returns the old
	 * locators that followed.
	 */
	followed(moves: Map<string, string>): Promise<Set<string>> {
		return this.store.relocate(this.userId, moves, true);
	}

	/** Refs of messages that are gone fail at once from now on, without searching every folder. */
	gone(locators: string[]): Promise<void> {
		return this.store.forgetMessageIds(this.userId, locators);
	}

	/** Points the refs of messages in a renamed or moved folder and its subfolders at the new paths. */
	async folderMoved(
		accountId: string,
		from: string,
		to: string,
		delimiter: string | null
	): Promise<void> {
		const moves = new Map<string, string>();
		for (const row of await this.store.forAccount(this.userId, accountId)) {
			const renamed = renamedFolderRef(row.locator, from, to, delimiter);
			if (renamed) moves.set(row.locator, renamed);
		}
		await this.moved(moves);
	}
}
