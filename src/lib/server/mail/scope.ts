import { error } from '@sveltejs/kit';
import { scopeIds } from '../../mail-scope';
import { isFolderRole, LIST_FILTERS, type ListFilter } from '../../mail-types';
import { getAccount, listAccounts } from './accounts';
import { MailError } from './errors';
import type { MailAccount } from './types';

/** The accounts a mail view covers: all of them, several, or one by ID. Unknown IDs are a 404. */
export async function scopeAccounts(
	userId: string,
	scope: string,
	folder: string
): Promise<MailAccount[]> {
	const ids = scopeIds(scope);
	if (!ids || ids.length > 1) {
		if (!isFolderRole(folder)) error(404, 'Unknown folder.');
		const accounts = await listAccounts(userId);
		if (!ids) return accounts;
		const chosen = accounts.filter((account) => ids.includes(account.id));
		if (chosen.length !== new Set(ids).size) error(404, 'Mail account not found.');
		return chosen;
	}
	try {
		return [await getAccount(userId, scope)];
	} catch (e) {
		if (e instanceof MailError && e.status === 404) error(404, 'Mail account not found.');
		throw e;
	}
}

export function parseFilter(value: string | null): ListFilter {
	return LIST_FILTERS.includes(value as ListFilter) ? (value as ListFilter) : 'all';
}
