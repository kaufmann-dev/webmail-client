import type { FolderRole } from '../../../mail-types';
import { MailError } from '../errors';
import type { Folder } from '../folders';
import type { MailAccount } from '../types';
import { check, ewsCall, failed } from './client';
import * as request from './requests';
import { attr, child, list, text, type XmlNode } from './xml';

export interface EwsFolders {
	folders: Folder[];
	idByPath: Map<string, string>;
	pathById: Map<string, string>;
}

const FOLDER_TTL_MS = 5 * 60_000;
const cache = new Map<string, EwsFolders & { at: number }>();

export function invalidateEwsFolders(accountId: string): void {
	cache.delete(accountId);
}

const DISTINGUISHED = [
	'msgfolderroot',
	'outbox',
	'inbox',
	'drafts',
	'sentitems',
	'deleteditems',
	'junkemail'
];
const ROLES: Record<string, FolderRole> = {
	inbox: 'inbox',
	drafts: 'drafts',
	sentitems: 'sent',
	deleteditems: 'trash',
	junkemail: 'spam'
};
/** Outlook's archive folder has no well-known ID; it is the top-level folder of this name. */
const ARCHIVE_NAMES = new Set(['archive', 'archiv']);

interface Entry {
	name: string;
	parent: string;
	visible: boolean;
}

function folderId(node: XmlNode | undefined): string {
	return attr(child(node, 'FolderId'), 'Id');
}

/**
 * Mail folders below the mailbox root, keyed by their display path (`Inbox/Projects`). Hidden,
 * non-mail (calendar, contacts, …) folders and the outbox are left out, with their subfolders.
 */
export function buildFolders(found: XmlNode[], distinguished: Map<string, string>): EwsFolders {
	const root = distinguished.get('msgfolderroot') ?? '';
	const outbox = distinguished.get('outbox');
	const entries = new Map<string, Entry>();
	for (const node of found) {
		const id = folderId(node);
		const folderClass = text(node.FolderClass);
		const hidden = list(node.ExtendedProperty).some((p) => text(p.Value) === 'true');
		entries.set(id, {
			name: text(node.DisplayName),
			parent: attr(child(node, 'ParentFolderId'), 'Id'),
			visible: !hidden && id !== outbox && (!folderClass || folderClass === 'IPF.Note')
		});
	}
	const names = new Map<string, string[] | null>();
	const pathOf = (id: string): string[] | null => {
		if (names.has(id)) return names.get(id)!;
		const entry = entries.get(id);
		let result: string[] | null = null;
		if (entry?.visible) {
			const parent = entry.parent === root ? [] : pathOf(entry.parent);
			result = parent ? [...parent, entry.name] : null;
		}
		names.set(id, result);
		return result;
	};

	const roleById = new Map<string, FolderRole>();
	for (const [name, role] of Object.entries(ROLES)) {
		const id = distinguished.get(name);
		if (id) roleById.set(id, role);
	}
	const folders: Folder[] = [];
	const idByPath = new Map<string, string>();
	const pathById = new Map<string, string>();
	const taken = new Set<FolderRole>();
	for (const id of entries.keys()) {
		const parts = pathOf(id);
		if (!parts) continue;
		const path = parts.join('/');
		let role = roleById.get(id) ?? null;
		if (!role && parts.length === 1 && ARCHIVE_NAMES.has(parts[0].toLowerCase())) role = 'archive';
		if (role && taken.has(role)) role = null;
		if (role) taken.add(role);
		folders.push({ path, name: parts[parts.length - 1], depth: parts.length - 1, role });
		idByPath.set(path, id);
		pathById.set(id, path);
	}
	return { folders, idByPath, pathById };
}

export async function ewsFolders(account: MailAccount): Promise<EwsFolders> {
	const cached = cache.get(account.id);
	if (cached && cached.at + FOLDER_TTL_MS > Date.now()) return cached;
	const [ids, found] = await Promise.all([
		ewsCall(account, request.distinguishedFolders(DISTINGUISHED)),
		ewsCall(account, request.findFolders())
	]);
	const distinguished = new Map<string, string>();
	ids.forEach((message, index) => {
		if (!failed(message)) {
			distinguished.set(DISTINGUISHED[index], folderId(child(child(message, 'Folders'), 'Folder')));
		}
	});
	const rootFolder = child(check(found[0]), 'RootFolder');
	const result = buildFolders(list(child(rootFolder, 'Folders')?.Folder), distinguished);
	cache.set(account.id, { ...result, at: Date.now() });
	return result;
}

export async function folderIdOf(account: MailAccount, path: string): Promise<string> {
	const id = (await ewsFolders(account)).idByPath.get(path);
	if (!id) throw new MailError('That folder does not exist.', 404);
	return id;
}

/** Creates the archive folder at the top level and returns its path. */
export async function createArchiveFolder(account: MailAccount): Promise<string> {
	const [message] = await ewsCall(account, request.createFolder('Archive'));
	if (text(message?.ResponseCode) !== 'ErrorFolderExists') check(message);
	invalidateEwsFolders(account.id);
	return 'Archive';
}

export async function inboxUnreadCount(account: MailAccount): Promise<number> {
	const [message] = await ewsCall(account, request.inboxUnread());
	const folder = child(child(check(message), 'Folders'), 'Folder');
	return Number(text(folder?.UnreadCount)) || 0;
}
