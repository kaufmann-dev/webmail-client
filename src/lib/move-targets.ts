import { FOLDER_ROLES, type FolderRole } from './mail-types.js';

export interface FolderEntry {
	path: string;
	name: string;
	depth: number;
	role: FolderRole | null;
}

/** A folder messages can move to; `accountId` is null for a role across all accounts. */
export interface MoveDestination {
	accountId: string | null;
	/** The move action's `target`: a role, or a folder path. */
	key: string;
	role: FolderRole | null;
}

/** The folder being viewed, which holds the messages being moved. */
export interface FolderView {
	role: FolderRole | null;
	folder: string;
}

export function folderDestination(accountId: string, entry: FolderEntry): MoveDestination {
	return { accountId, key: entry.role ?? entry.path, role: entry.role };
}

/**
 * Whether messages from `accountIds` in `view` can move to `destination`. Messages cannot cross
 * accounts or go into Drafts, and moving into the viewed folder would do nothing.
 */
export function canMoveTo(
	destination: MoveDestination,
	accountIds: ReadonlySet<string>,
	view: FolderView
): boolean {
	if (destination.role === 'drafts' || accountIds.size === 0) return false;
	if (destination.accountId !== null) {
		for (const id of accountIds) if (id !== destination.accountId) return false;
	}
	return destination.role ? destination.role !== view.role : destination.key !== view.folder;
}

/** Menu choices: the account's folders when all messages share one, otherwise the shared roles. */
export function moveDestinations(
	folders: Record<string, FolderEntry[]>,
	accountIds: ReadonlySet<string>,
	view: FolderView
): MoveDestination[] {
	const [only] = accountIds;
	const all =
		accountIds.size === 1
			? (folders[only] ?? []).map((entry) => folderDestination(only, entry))
			: FOLDER_ROLES.map((role) => ({ accountId: null, key: role, role }));
	return all.filter((destination) => canMoveTo(destination, accountIds, view));
}
