import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMessage } from './errors';
import { EARLY_MS, inStages } from './stages';
import type { MailAccount } from './types';

const fast = { id: 'fast', email: 'fast@example.com' } as MailAccount;
const slow = { id: 'slow', email: 'slow@example.com' } as MailAccount;

const after = (ms: number, value: string) =>
	new Promise<string>((resolve) => setTimeout(() => resolve(value), ms));
const fallback = (account: MailAccount, error: unknown) => `${account.id}: ${errorMessage(error)}`;

describe('inStages', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('has everything early and no late stage when all accounts answer in time', async () => {
		const stages = inStages([fast, slow], (a) => after(100, a.id), fallback);
		await vi.advanceTimersByTimeAsync(100);
		const early = await stages.early;
		expect([...early.results]).toEqual([
			['fast', 'fast'],
			['slow', 'slow']
		]);
		expect(early.pending).toEqual([]);
		expect(await stages.late).toBeNull();
	});

	it('leaves a slow account to the late stage', async () => {
		const stages = inStages([fast, slow], (a) => after(a === fast ? 100 : 10_000, a.id), fallback);
		await vi.advanceTimersByTimeAsync(EARLY_MS);
		const early = await stages.early;
		expect([...early.results.keys()]).toEqual(['fast']);
		expect(early.pending).toEqual(['slow']);
		await vi.advanceTimersByTimeAsync(10_000);
		expect([...((await stages.late) ?? [])]).toEqual([
			['fast', 'fast'],
			['slow', 'slow']
		]);
	});

	it('falls back for failed and unanswered loads', async () => {
		const stages = inStages(
			[fast, slow],
			(a) => (a === fast ? Promise.reject(new Error('rejected')) : new Promise<string>(() => {})),
			fallback
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect([...((await stages.late) ?? [])]).toEqual([
			['fast', 'fast: rejected'],
			['slow', 'slow: slow@example.com: the mail server is not responding.']
		]);
	});
});
