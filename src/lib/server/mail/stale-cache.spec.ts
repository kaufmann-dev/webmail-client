import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { staleCache } from './stale-cache';
import type { MailAccount } from './types';

const account = { id: 'a1' } as MailAccount;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('staleCache', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('loads once while fresh', async () => {
		const load = vi.fn(async () => 'v1');
		const cache = staleCache(1000, load);
		expect(await cache.get(account)).toBe('v1');
		expect(await cache.get(account)).toBe('v1');
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('shares a first load between concurrent callers', async () => {
		const load = vi.fn(async () => 'v1');
		const cache = staleCache(1000, load);
		expect(await Promise.all([cache.get(account), cache.get(account)])).toEqual(['v1', 'v1']);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('returns a stale value at once and replaces it in the background', async () => {
		const next = deferred<string>();
		const load = vi.fn().mockResolvedValueOnce('v1').mockReturnValueOnce(next.promise);
		const cache = staleCache(1000, load);
		await cache.get(account);
		vi.advanceTimersByTime(1001);
		expect(await cache.get(account)).toBe('v1');
		expect(await cache.get(account)).toBe('v1');
		expect(load).toHaveBeenCalledTimes(2);
		next.resolve('v2');
		await next.promise;
		expect(await cache.get(account)).toBe('v2');
	});

	it('keeps the stale value when the reload fails', async () => {
		const load = vi.fn().mockResolvedValueOnce('v1').mockRejectedValueOnce(new Error('down'));
		load.mockResolvedValueOnce('v3');
		const cache = staleCache(1000, load);
		await cache.get(account);
		vi.advanceTimersByTime(1001);
		expect(await cache.get(account)).toBe('v1');
		await Promise.resolve();
		expect(await cache.get(account)).toBe('v1');
		expect(load).toHaveBeenCalledTimes(3);
	});

	it('does not write back a reload started before invalidation', async () => {
		const old = deferred<string>();
		const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce('fresh');
		const cache = staleCache(1000, load);
		const first = cache.get(account);
		cache.invalidate(account.id);
		old.resolve('old');
		expect(await first).toBe('old');
		expect(await cache.get(account)).toBe('fresh');
		expect(await cache.get(account)).toBe('fresh');
	});
});
