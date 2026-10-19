import { isFolderRole, type FolderRole } from './mail-types.js';
import type { FolderEntry } from './move-targets.js';

/**
 * A mail view's scope: `all`, one account ID, or several account IDs joined by this separator
 * (a combined view, which shows the shared roles like `all`).
 */
export const SCOPE_SEPARATOR = '+';

/** The account IDs a scope names; null for `all`. */
export function scopeIds(scope: string): string[] | null {
	return scope === 'all' ? null : scope.split(SCOPE_SEPARATOR);
}

/** The account ID when the scope is a single account, else null. */
export function singleAccount(scope: string): string | null {
	const ids = scopeIds(scope);
	return ids?.length === 1 ? ids[0] : null;
}

/** The IDs of the accounts a scope covers, in their Settings order. */
export function scopeAccountIds(scope: string, accounts: { id: string }[]): string[] {
	const ids = scopeIds(scope);
	return accounts.map((a) => a.id).filter((id) => !ids || ids.includes(id));
}

/** The canonical scope of a selection: `all` for every account (or none), else the IDs in order. */
export function scopeFor(ids: Iterable<string>, accounts: { id: string }[]): string {
	const chosen = new Set(ids);
	const ordered = accounts.map((a) => a.id).filter((id) => chosen.has(id));
	if (!ordered.length || ordered.length === accounts.length) return 'all';
	return ordered.join(SCOPE_SEPARATOR);
}

/** The scope after ticking or unticking `id`; the last remaining account cannot be unticked. */
export function toggledScope(scope: string, id: string, accounts: { id: string }[]): string {
	const selected = new Set(scopeAccountIds(scope, accounts));
	if (!selected.delete(id)) selected.add(id);
	else if (!selected.size) return scope;
	return scopeFor(selected, accounts);
}

/** The role of the viewed folder, given as a role or a folder path; null for a custom folder. */
export function viewedRole(
	scope: string,
	folder: string,
	folders: Record<string, FolderEntry[]>
): FolderRole | null {
	if (isFolderRole(folder)) return folder;
	return folders[scope]?.find((entry) => entry.path === folder)?.role ?? null;
}

/**
 * The folder to open when switching to `scope`. Switching accounts keeps the kind of folder being
 * viewed (Sent stays on Sent); a custom folder, or a role the account lacks, opens the inbox.
 */
export function switchedFolder(
	role: FolderRole | null,
	scope: string,
	folders: Record<string, FolderEntry[]>
): string {
	if (!role) return 'inbox';
	if (!singleAccount(scope)) return role;
	return folders[scope]?.some((entry) => entry.role === role) ? role : 'inbox';
}
