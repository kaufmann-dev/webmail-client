import { describe, expect, it } from 'vitest';
import { InvalidMessageRefError } from '../mail/message-ref';
import { EventRefs, type EventRefRow, type EventRefStore } from './event-refs';

function memoryStore(): EventRefStore {
	const rows = new Map<string, EventRefRow & { userId: string }>();
	let next = 0;
	return {
		async mint(userId, accountId, itemIds) {
			const result = new Map<string, string>();
			for (const itemId of itemIds) {
				let id = [...rows].find(
					([, row]) => row.userId === userId && row.accountId === accountId && row.itemId === itemId
				)?.[0];
				if (!id) {
					id = `ref${next++}`;
					rows.set(id, { userId, accountId, itemId });
				}
				result.set(itemId, id);
			}
			return result;
		},
		async find(userId, id) {
			const row = rows.get(id);
			return row && row.userId === userId ? { accountId: row.accountId, itemId: row.itemId } : null;
		}
	};
}

describe('EventRefs', () => {
	it('keeps one ref per event and resolves it for its user only', async () => {
		const store = memoryStore();
		const refs = new EventRefs('u1', store);
		const first = await refs.shorten('acc', ['AAMk1', 'AAMk2', 'AAMk1']);
		const again = await refs.shorten('acc', ['AAMk1']);
		expect(first.size).toBe(2);
		expect(again.get('AAMk1')).toBe(first.get('AAMk1'));
		await expect(refs.resolve(` ${first.get('AAMk2')} `)).resolves.toEqual({
			accountId: 'acc',
			itemId: 'AAMk2'
		});
		await expect(new EventRefs('u2', store).resolve(first.get('AAMk2')!)).rejects.toThrow(
			InvalidMessageRefError
		);
	});
});
