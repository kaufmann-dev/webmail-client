import type { ListResponse } from 'imapflow';
import { FOLDER_ROLES, isFolderRole, type FolderRole } from '../../mail-types';
import { MailError } from './errors';
import { withClient } from './imap';
import { PROVIDER_CONFIG } from './providers';
import type { MailAccount } from './types';

export interface Folder {
	path: string;
	name: string;
	depth: number;
	role: FolderRole | null;
}

const FOLDER_TTL_MS = 5 * 60_000;
const cache = new Map<string, { folders: Folder[]; at: number }>();

export function invalidateFolders(accountId: string): void {
	cache.delete(accountId);
}

const SPECIAL_USE_ROLES: Record<string, FolderRole> = {
	'\\Inbox': 'inbox',
	'\\Drafts': 'drafts',
	'\\Sent': 'sent',
	'\\Junk': 'spam',
	'\\Trash': 'trash'
};

/** Gmail's label views that duplicate other folders and are not useful as plain folders. */
const HIDDEN_SPECIAL_USE = new Set(['\\Flagged', '\\Important']);

export function folderRole(account: Pick<MailAccount, 'provider'>, entry: ListResponse) {
	if (entry.path.toUpperCase() === 'INBOX') return 'inbox';
	if (!entry.specialUse) return null;
	if (entry.specialUse === PROVIDER_CONFIG[account.provider].archiveSpecialUse) return 'archive';
	return SPECIAL_USE_ROLES[entry.specialUse] ?? null;
}

/** Selectable folders: role folders in a fixed order, then custom folders by path. */
export async function getFolders(account: MailAccount): Promise<Folder[]> {
	const cached = cache.get(account.id);
	if (cached && cached.at + FOLDER_TTL_MS > Date.now()) return cached.folders;
	const entries = await withClient(account, (client) => client.list());
	const taken = new Set<FolderRole>();
	const folders: Folder[] = [];
	for (const entry of entries) {
		if (entry.flags.has('\\Noselect') || entry.flags.has('\\NonExistent')) continue;
		let role: FolderRole | null = folderRole(account, entry);
		if (role && taken.has(role)) role = null;
		if (
			!role &&
			entry.specialUse &&
			(HIDDEN_SPECIAL_USE.has(entry.specialUse) || entry.specialUse === '\\All')
		) {
			continue;
		}
		if (role) taken.add(role);
		folders.push({ path: entry.path, name: entry.name, depth: entry.parent.length, role });
	}
	folders.sort((a, b) => {
		const ra = a.role ? FOLDER_ROLES.indexOf(a.role) : FOLDER_ROLES.length;
		const rb = b.role ? FOLDER_ROLES.indexOf(b.role) : FOLDER_ROLES.length;
		return ra - rb || a.path.localeCompare(b.path);
	});
	cache.set(account.id, { folders, at: Date.now() });
	return folders;
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
	const created = await withClient(account, (client) => client.mailboxCreate('Archive'));
	invalidateFolders(account.id);
	return created.path;
}

/** INBOX unread counts; null for accounts that could not be reached. */
export async function inboxUnreadCounts(
	accounts: MailAccount[]
): Promise<Record<string, number | null>> {
	const entries = await Promise.all(
		accounts.map(async (account) => {
			try {
				const status = await withClient(account, (client) =>
					client.status('INBOX', { unseen: true })
				);
				return [account.id, status ? (status.unseen ?? 0) : null] as const;
			} catch {
				return [account.id, null] as const;
			}
		})
	);
	return Object.fromEntries(entries);
}
