import { error } from '@sveltejs/kit';
import { isFolderRole, LIST_FILTERS, type ListFilter } from '../../mail-types';
import { getAccount, listAccounts } from './accounts';
import { MailError } from './errors';
import type { MailAccount } from './types';

/** The accounts a mail view covers: all of them, or one by ID. Unknown IDs are a 404. */
export async function scopeAccounts(
	userId: string,
	scope: string,
	folder: string
): Promise<MailAccount[]> {
	if (scope === 'all') {
		if (!isFolderRole(folder)) error(404, 'Unknown folder.');
		return listAccounts(userId);
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
