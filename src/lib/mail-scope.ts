import { isFolderRole, type FolderRole } from './mail-types.js';
import type { FolderEntry } from './move-targets.js';

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
	if (scope === 'all') return role;
	return folders[scope]?.some((entry) => entry.role === role) ? role : 'inbox';
}
