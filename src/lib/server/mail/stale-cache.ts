import type { MailAccount } from './types';

/**
 * Per-account values that stay fresh for `ttlMs`. A stale value is returned at once while one
 * background reload replaces it; a failed reload keeps it. A reload started before `invalidate`
 * never writes back.
 */
export function staleCache<T>(ttlMs: number, load: (account: MailAccount) => Promise<T>) {
	const entries = new Map<string, { value: T; at: number }>();
	const reloads = new Map<string, Promise<T>>();

	function reload(account: MailAccount): Promise<T> {
		const pending = load(account).then(
			(value) => {
				if (reloads.get(account.id) === pending) {
					reloads.delete(account.id);
					entries.set(account.id, { value, at: Date.now() });
				}
				return value;
			},
			(error) => {
				if (reloads.get(account.id) === pending) reloads.delete(account.id);
				throw error;
			}
		);
		reloads.set(account.id, pending);
		return pending;
	}

	return {
		async get(account: MailAccount): Promise<T> {
			const entry = entries.get(account.id);
			if (entry && entry.at + ttlMs > Date.now()) return entry.value;
			if (entry) {
				if (!reloads.has(account.id)) reload(account).catch(() => {});
				return entry.value;
			}
			return reloads.get(account.id) ?? reload(account);
		},
		invalidate(accountId: string): void {
			entries.delete(accountId);
			reloads.delete(accountId);
		}
	};
}
