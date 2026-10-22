import { MailError } from './errors';
import type { MailAccount } from './types';

/** How long a view waits for its accounts before it shows those that answered. */
export const EARLY_MS = 4_000;
/** An account that has not answered by then counts as failed. */
const GIVE_UP_MS = 60_000;

export interface Stages<T> {
	/** Results of the accounts that answered within `EARLY_MS`, and the IDs of those still running. */
	early: Promise<{ results: Map<string, T>; pending: string[] }>;
	/** Every account's result, or null when `early` already had them all. */
	late: Promise<Map<string, T> | null>;
}

/**
 * Loads every account once and reports the results in two stages, so one slow account holds up
 * nothing else. A failed or unanswered load becomes `fallback`; neither stage rejects.
 */
export function inStages<T>(
	accounts: MailAccount[],
	load: (account: MailAccount) => Promise<T>,
	fallback: (account: MailAccount, error: unknown) => T
): Stages<T> {
	const settled = new Map<string, T>();
	const tasks = accounts.map((account) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const giveUp = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new MailError(`${account.email}: the mail server is not responding.`, 504)),
				GIVE_UP_MS
			);
		});
		return Promise.race([load(account), giveUp])
			.catch((error: unknown) => fallback(account, error))
			.then((result) => {
				clearTimeout(timer);
				settled.set(account.id, result);
				return [account.id, result] as const;
			});
	});
	const all = Promise.all(tasks).then((entries) => new Map(entries));

	let timer: ReturnType<typeof setTimeout> | undefined;
	const wait = new Promise<void>((resolve) => (timer = setTimeout(resolve, EARLY_MS)));
	const early = Promise.race([all, wait]).then(() => {
		clearTimeout(timer);
		return {
			results: new Map(settled),
			pending: accounts.filter((a) => !settled.has(a.id)).map((a) => a.id)
		};
	});
	return { early, late: early.then(({ pending }) => (pending.length ? all : null)) };
}
