import type { ListResponse } from 'imapflow';
import { FOLDER_ROLE_LABELS, FOLDER_ROLES, isFolderRole, type FolderRole } from '../../mail-types';
import { isWithin, parentPath } from '../../folder-tree';
import { MailError } from './errors';
import {
	createArchiveFolder,
	createEwsFolder,
	deleteEwsFolder,
	ewsFolders,
	ewsFolderTotal,
	inboxUnreadCount,
	invalidateEwsFolders,
	moveEwsFolder,
	renameEwsFolder
} from './ews/folders';
import { withClient } from './imap';
import { PROVIDER_CONFIG, type ImapProvider } from './providers';
import { staleCache } from './stale-cache';
import type { MailAccount } from './types';

export interface Folder {
	path: string;
	name: string;
	depth: number;
	role: FolderRole | null;
}

const cache = staleCache(5 * 60_000, listFolders);

export function invalidateFolders(accountId: string): void {
	cache.invalidate(accountId);
	invalidateEwsFolders(accountId);
}

const SPECIAL_USE_ROLES: Record<string, FolderRole> = {
	'\\Inbox': 'inbox',
	'\\Drafts': 'drafts',
	'\\Sent': 'sent',
	'\\Junk': 'spam',
	'\\Trash': 'trash'
};

/** Gmail's label views that duplicate other folders and are not useful as plain folders. */
const HIDDEN_ATTRIBUTES = ['\\All', '\\Flagged', '\\Important'];

/**
 * Whether a folder without a role is one of Gmail's label views. imapflow reports only RFC 6154
 * flags as `specialUse`, so `\Important` is found among the folder's own attributes.
 */
export function isHiddenFolder(entry: Pick<ListResponse, 'flags' | 'specialUse'>): boolean {
	return HIDDEN_ATTRIBUTES.some((flag) => entry.specialUse === flag || entry.flags.has(flag));
}

export function folderRole(provider: ImapProvider, entry: ListResponse) {
	if (entry.path.toUpperCase() === 'INBOX') return 'inbox';
	if (!entry.specialUse) return null;
	if (entry.specialUse === PROVIDER_CONFIG[provider].archiveSpecialUse) return 'archive';
	return SPECIAL_USE_ROLES[entry.specialUse] ?? null;
}

/** Role folders in a fixed order, then custom folders by path. */
function sortFolders(folders: Folder[]): Folder[] {
	return folders.sort((a, b) => {
		const ra = a.role ? FOLDER_ROLES.indexOf(a.role) : FOLDER_ROLES.length;
		const rb = b.role ? FOLDER_ROLES.indexOf(b.role) : FOLDER_ROLES.length;
		return ra - rb || a.path.localeCompare(b.path);
	});
}

/**
 * Selectable folders: role folders in a fixed order, then custom folders by path. A stale list is
 * returned at once while it reloads in the background.
 */
export async function getFolders(account: MailAccount): Promise<Folder[]> {
	if (account.provider === 'exchange') {
		return sortFolders([...(await ewsFolders(account)).folders]);
	}
	return cache.get(account);
}

async function listFolders(account: MailAccount): Promise<Folder[]> {
	if (account.provider === 'exchange') throw new Error('Exchange accounts do not use IMAP.');
	const provider = account.provider;
	const entries = await withClient(account, (client) => client.list());
	const taken = new Set<FolderRole>();
	const folders: Folder[] = [];
	for (const entry of entries) {
		if (entry.flags.has('\\Noselect') || entry.flags.has('\\NonExistent')) continue;
		let role: FolderRole | null = folderRole(provider, entry);
		if (role && taken.has(role)) role = null;
		if (!role && isHiddenFolder(entry)) continue;
		if (role) taken.add(role);
		folders.push({ path: entry.path, name: entry.name, depth: entry.parent.length, role });
	}
	return sortFolders(folders);
}

/** The mailbox path for a role (`inbox`, `sent`, …) or an existing path; null when absent. */
export async function resolveFolder(
	account: MailAccount,
	roleOrPath: string
): Promise<string | null> {
	const folders = await getFolders(account);
	if (isFolderRole(roleOrPath)) return folders.find((f) => f.role === roleOrPath)?.path ?? null;
	return folders.find((f) => f.path === roleOrPath)?.path ?? null;
}

export async function requireFolder(account: MailAccount, roleOrPath: string): Promise<string> {
	const path = await resolveFolder(account, roleOrPath);
	if (!path) throw new MailError(`${account.email} has no folder "${roleOrPath}".`, 404);
	return path;
}

/** The archive folder, created as "Archive" for providers that start without one. */
export async function ensureArchiveFolder(account: MailAccount): Promise<string> {
	const existing = await resolveFolder(account, 'archive');
	if (existing) return existing;
	if (account.provider === 'gmail') throw new MailError('Gmail All Mail folder not found.', 404);
	if (account.provider === 'exchange') return createArchiveFolder(account);
	const created = await withClient(account, (client) => client.mailboxCreate('Archive'));
	invalidateFolders(account.id);
	return created.path;
}

const NAME_MAX = 100;

/** A trimmed folder name that is one path segment on every provider. */
function folderName(raw: string): string {
	const name = raw.trim();
	if (!name) throw new MailError('Enter a folder name.', 400);
	if (name.length > NAME_MAX) {
		throw new MailError(`Folder names can have at most ${NAME_MAX} characters.`, 400);
	}
	if (/[/\\]/.test(name)) throw new MailError('Folder names cannot contain "/" or "\\".', 400);
	return name;
}

/** Rejects a name containing the IMAP server's hierarchy delimiter, which would nest it. */
function requireNoDelimiter(name: string, delimiter: string | null | undefined): void {
	if (delimiter && name.includes(delimiter)) {
		throw new MailError(`Folder names cannot contain "${delimiter}" on this server.`, 400);
	}
}

async function findFolder(account: MailAccount, path: string): Promise<Folder> {
	const folder = (await getFolders(account)).find((f) => f.path === path);
	if (!folder) throw new MailError('That folder does not exist.', 404);
	return folder;
}

/** A folder the user may rename or delete: not one of the role folders. */
async function customFolder(account: MailAccount, path: string): Promise<Folder> {
	const folder = await findFolder(account, path);
	if (folder.role) {
		throw new MailError(`${FOLDER_ROLE_LABELS[folder.role]} cannot be changed.`, 400);
	}
	return folder;
}

async function requireFreeName(
	account: MailAccount,
	parent: string | null,
	name: string,
	except?: string
): Promise<void> {
	const taken = (await getFolders(account)).some(
		(f) =>
			f.path !== except && parentPath(f) === parent && f.name.toLowerCase() === name.toLowerCase()
	);
	if (taken) throw new MailError(`A folder named "${name}" already exists here.`, 409);
}

/** Creates a folder below `parent` (a path) or at the top level and returns its path. */
export async function createFolder(
	account: MailAccount,
	parent: string | null,
	rawName: string
): Promise<string> {
	const name = folderName(rawName);
	if (parent) await findFolder(account, parent);
	await requireFreeName(account, parent, name);
	if (account.provider === 'exchange') return createEwsFolder(account, parent, name);
	const created = await withClient(account, (client) => {
		requireNoDelimiter(name, client.namespace?.delimiter);
		return client.mailboxCreate(parent ? [parent, name] : name);
	});
	invalidateFolders(account.id);
	return created.path;
}

/**
 * Renames a folder in place. Returns its new path and the hierarchy delimiter, which separates
 * the paths of its subfolders (they move along); null on a server without hierarchy.
 */
export async function renameFolder(
	account: MailAccount,
	path: string,
	rawName: string
): Promise<{ path: string; delimiter: string | null }> {
	const name = folderName(rawName);
	const parent = parentPath(await customFolder(account, path));
	await requireFreeName(account, parent, name, path);
	if (account.provider === 'exchange') return renameEwsFolder(account, path, parent, name);
	return relocateImapFolder(account, path, parent, name);
}

/**
 * Moves a folder with its subfolders below `parent` (a path) or to the top level, keeping its
 * name. Returns its new path and the hierarchy delimiter, as `renameFolder` does.
 */
export async function moveFolder(
	account: MailAccount,
	path: string,
	parent: string | null
): Promise<{ path: string; delimiter: string | null }> {
	const folder = await customFolder(account, path);
	if (parent !== null) {
		await findFolder(account, parent);
		if (isWithin(parent, folder, await getFolders(account))) {
			throw new MailError('A folder cannot move into itself or one of its subfolders.', 400);
		}
	}
	if (parentPath(folder) === parent) {
		throw new MailError(`"${folder.name}" is already there.`, 400);
	}
	await requireFreeName(account, parent, folder.name, path);
	if (account.provider === 'exchange') return moveEwsFolder(account, path, parent, folder.name);
	return relocateImapFolder(account, path, parent, folder.name);
}

/** Renames an IMAP folder to `name` below `parent`; its subfolders move along. */
async function relocateImapFolder(
	account: MailAccount,
	path: string,
	parent: string | null,
	name: string
): Promise<{ path: string; delimiter: string | null }> {
	const relocated = await withClient(account, async (client) => {
		const delimiter = client.namespace?.delimiter || null;
		requireNoDelimiter(name, delimiter);
		const result = await client.mailboxRename(path, parent ? [parent, name] : name);
		return { path: result.newPath, delimiter };
	});
	invalidateFolders(account.id);
	return relocated;
}

function requireEmpty(path: string, count: number): void {
	if (!count) return;
	throw new MailError(
		`"${path}" or its subfolders still hold ${count} message${count === 1 ? '' : 's'}. Move or trash them first.`,
		409
	);
}

/**
 * Deletes a folder with its subfolders and all their messages. With `onlyEmpty`, a folder whose
 * subtree still holds messages is refused instead.
 */
export async function deleteFolder(
	account: MailAccount,
	path: string,
	options: { onlyEmpty?: boolean } = {}
): Promise<void> {
	await customFolder(account, path);
	if (account.provider === 'exchange') {
		if (options.onlyEmpty) requireEmpty(path, await ewsFolderTotal(account, path));
		return deleteEwsFolder(account, path);
	}
	await withClient(account, async (client) => {
		const entries = (
			await client.list(options.onlyEmpty ? { statusQuery: { messages: true } } : undefined)
		).filter((entry) => entry.path === path || entry.path.startsWith(path + entry.delimiter));
		if (options.onlyEmpty) {
			requireEmpty(
				path,
				entries.reduce((sum, entry) => sum + (entry.status?.messages ?? 0), 0)
			);
		}
		const doomed = entries
			.map((entry) => entry.path)
			// Subfolders first: servers refuse to delete a folder that still has children.
			.sort((a, b) => b.length - a.length);
		for (const doomedPath of doomed) await client.mailboxDelete(doomedPath);
	});
	invalidateFolders(account.id);
}

/** The INBOX unread count; null when the account could not be reached. */
export async function inboxUnread(account: MailAccount): Promise<number | null> {
	try {
		if (account.provider === 'exchange') return await inboxUnreadCount(account);
		const status = await withClient(account, (client) => client.status('INBOX', { unseen: true }));
		return status ? (status.unseen ?? 0) : null;
	} catch {
		return null;
	}
}
