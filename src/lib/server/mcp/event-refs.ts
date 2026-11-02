import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { mcpEventRef } from '../db/schema';
import { InvalidMessageRefError } from '../mail/message-ref';
import { newRefId } from './refs';

/** An Exchange calendar item behind a short event ref. */
export interface EventRefRow {
	accountId: string;
	itemId: string;
}

/** Where short event refs are kept; tests substitute their own. */
export interface EventRefStore {
	/** The short ref of each item, created where missing. */
	mint(userId: string, accountId: string, itemIds: string[]): Promise<Map<string, string>>;
	find(userId: string, id: string): Promise<EventRefRow | null>;
}

const dbStore: EventRefStore = {
	async mint(userId, accountId, itemIds) {
		if (!itemIds.length) return new Map();
		const minted = await db
			.insert(mcpEventRef)
			.values(itemIds.map((itemId) => ({ id: newRefId(), userId, accountId, itemId })))
			.onConflictDoUpdate({
				target: [mcpEventRef.userId, mcpEventRef.accountId, mcpEventRef.itemId],
				// A no-op update, so that existing rows are returned too.
				set: { userId }
			})
			.returning({ id: mcpEventRef.id, itemId: mcpEventRef.itemId });
		return new Map(minted.map((row) => [row.itemId, row.id]));
	},
	async find(userId, id) {
		const [row] = await db
			.select({ accountId: mcpEventRef.accountId, itemId: mcpEventRef.itemId })
			.from(mcpEventRef)
			.where(and(eq(mcpEventRef.userId, userId), eq(mcpEventRef.id, id)));
		return row ?? null;
	}
};

/**
 * Short, stable refs for one user's calendar events. EWS item IDs run to about 150 characters; AI
 * clients get 10 instead. They live apart from message refs, so no message tool accepts them.
 */
export class EventRefs {
	constructor(
		private readonly userId: string,
		private readonly store: EventRefStore = dbStore
	) {}

	/** Short refs by item ID, created where missing. */
	shorten(accountId: string, itemIds: string[]): Promise<Map<string, string>> {
		return this.store.mint(this.userId, accountId, [...new Set(itemIds)]);
	}

	async resolve(id: string): Promise<EventRefRow> {
		const row = await this.store.find(this.userId, id.trim());
		if (!row) {
			throw new InvalidMessageRefError('Unknown event_ref. Use an event_ref from list_events.');
		}
		return row;
	}
}
