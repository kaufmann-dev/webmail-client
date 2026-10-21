import type { FolderRole } from '../../../mail-types';
import { MailError } from '../errors';
import type { Folder } from '../folders';
import { staleCache } from '../stale-cache';
import type { MailAccount } from '../types';
import { check, ewsCall, failed } from './client';
import * as request from './requests';
import { attr, child, list, text, type XmlNode } from './xml';

export interface EwsFolders {
	folders: Folder[];
	idByPath: Map<string, string>;
	pathById: Map<string, string>;
}

const cache = staleCache(5 * 60_000, findFolders);

export function invalidateEwsFolders(accountId: string): void {
	cache.invalidate(accountId);
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

/** The account's folders. A stale list is returned at once while it reloads in the background. */
export function ewsFolders(account: MailAccount): Promise<EwsFolders> {
	return cache.get(account);
}

async function findFolders(account: MailAccount): Promise<EwsFolders> {
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
	return buildFolders(list(child(rootFolder, 'Folders')?.Folder), distinguished);
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

function checkFolder(message: XmlNode | undefined, name: string): void {
	if (text(message?.ResponseCode) === 'ErrorFolderExists') {
		throw new MailError(`A folder named "${name}" already exists here.`, 409);
	}
	check(message);
}

/** Creates a folder below `parent` (a path) or at the top level and returns its path. */
export async function createEwsFolder(
	account: MailAccount,
	parent: string | null,
	name: string
): Promise<string> {
	const parentId = parent ? await folderIdOf(account, parent) : undefined;
	const [message] = await ewsCall(account, request.createFolder(name, parentId));
	checkFolder(message, name);
	invalidateEwsFolders(account.id);
	return parent ? `${parent}/${name}` : name;
}

export async function renameEwsFolder(
	account: MailAccount,
	path: string,
	parent: string | null,
	name: string
): Promise<{ path: string; delimiter: string }> {
	const [message] = await ewsCall(
		account,
		request.renameFolder(await folderIdOf(account, path), name)
	);
	checkFolder(message, name);
	invalidateEwsFolders(account.id);
	return { path: parent ? `${parent}/${name}` : name, delimiter: '/' };
}

/** Moves the folder `name` at `path` below `parent` (a path) or to the top level. */
export async function moveEwsFolder(
	account: MailAccount,
	path: string,
	parent: string | null,
	name: string
): Promise<{ path: string; delimiter: string }> {
	const [id, parentId] = await Promise.all([
		folderIdOf(account, path),
		parent ? folderIdOf(account, parent) : undefined
	]);
	const [message] = await ewsCall(account, request.moveFolder(id, parentId));
	checkFolder(message, name);
	invalidateEwsFolders(account.id);
	return { path: parent ? `${parent}/${name}` : name, delimiter: '/' };
}

/** The number of messages in a folder and all its subfolders. */
export async function ewsFolderTotal(account: MailAccount, path: string): Promise<number> {
	const id = await folderIdOf(account, path);
	const [[own], [below]] = await Promise.all([
		ewsCall(account, request.folderTotal(id)),
		ewsCall(account, request.subfolderTotals(id))
	]);
	const folders = [
		child(child(check(own), 'Folders'), 'Folder'),
		...list(child(child(check(below), 'RootFolder'), 'Folders')?.Folder)
	];
	return folders.reduce((sum, folder) => sum + (Number(text(folder?.TotalCount)) || 0), 0);
}

/** Deletes a folder with its subfolders and messages. */
export async function deleteEwsFolder(account: MailAccount, path: string): Promise<void> {
	const [message] = await ewsCall(account, request.deleteFolder(await folderIdOf(account, path)));
	check(message);
	invalidateEwsFolders(account.id);
}

export async function inboxUnreadCount(account: MailAccount): Promise<number> {
	const [message] = await ewsCall(account, request.inboxUnread());
	const folder = child(child(check(message), 'Folders'), 'Folder');
	return Number(text(folder?.UnreadCount)) || 0;
}
