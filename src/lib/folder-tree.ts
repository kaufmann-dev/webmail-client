import type { FolderRole } from './mail-types.js';

/** A folder list row: whether it has subfolders and whether they show. */
export interface TreeRow<T> {
	item: T;
	hasChildren: boolean;
	expanded: boolean;
}

/**
 * The rows of a folder list in tree order (each folder followed by its deeper subfolders) with
 * collapsed folders' subfolders left out. A collapsed folder stays open while it holds the active
 * folder, so the open folder is always visible.
 */
export function visibleTree<T extends { key: string; depth: number }>(
	items: T[],
	collapsed: ReadonlySet<string>,
	activeKey: string
): TreeRow<T>[] {
	const rows: TreeRow<T>[] = [];
	let hideBelow: number | null = null;
	items.forEach((item, index) => {
		if (hideBelow !== null && item.depth > hideBelow) return;
		hideBelow = null;
		let end = index + 1;
		while (end < items.length && items[end].depth > item.depth) end++;
		const hasChildren = end > index + 1;
		const holdsActive = items.slice(index + 1, end).some((child) => child.key === activeKey);
		const expanded = hasChildren && (!collapsed.has(item.key) || holdsActive);
		if (hasChildren && !expanded) hideBelow = item.depth;
		rows.push({ item, hasChildren, expanded });
	});
	return rows;
}

interface NamedFolder {
	path: string;
	name: string;
	depth: number;
}

/** The path of the folder that holds `folder`; null at the top level. */
export function parentPath(folder: NamedFolder): string | null {
	return folder.depth ? folder.path.slice(0, -folder.name.length - 1) : null;
}

/**
 * The folders `folder` can move into, in tree order with their depth: all but itself and its
 * subfolders, and without role folders unless `roles` is set.
 */
export function moveParents<T extends NamedFolder & { role: FolderRole | null }>(
	folder: NamedFolder,
	entries: T[],
	options: { roles: boolean }
): { folder: T; depth: number }[] {
	return nestFolders(entries.filter((entry) => options.roles || !entry.role)).filter(
		({ folder: entry }) => !isWithin(entry.path, folder, entries)
	);
}

/**
 * The path of `folder` once moved below `parent` (null: the top level). The delimiter is taken
 * from a nested entry; null when no entry is nested, so it cannot be known.
 */
export function movedPath(
	folder: NamedFolder,
	parent: string | null,
	entries: NamedFolder[]
): string | null {
	if (parent === null) return folder.name;
	const nested = entries.find((entry) => entry.depth > 0);
	if (!nested) return null;
	const delimiter = nested.path.charAt(nested.path.length - nested.name.length - 1);
	return parent + delimiter + folder.name;
}

/**
 * Folders in tree order, each followed by its subfolders, with their depth in that tree. Roots
 * and siblings keep their order in `folders`. A folder whose parent is not listed (such as
 * Gmail's unselectable `[Gmail]`) is a root, so subfolders of role folders sit below them.
 */
export function nestFolders<T extends NamedFolder>(folders: T[]): { folder: T; depth: number }[] {
	const paths = new Set(folders.map((f) => f.path));
	const children = new Map<string | null, T[]>();
	for (const folder of folders) {
		const parent = parentPath(folder);
		const key = parent !== null && paths.has(parent) ? parent : null;
		children.set(key, [...(children.get(key) ?? []), folder]);
	}
	const nested: { folder: T; depth: number }[] = [];
	const visit = (parent: string | null, depth: number) => {
		for (const folder of children.get(parent) ?? []) {
			nested.push({ folder, depth });
			visit(folder.path, depth + 1);
		}
	};
	visit(null, 0);
	return nested;
}

/** A folder's path once renamed to `name`: the parent path and its delimiter stay. */
export function renamedPath(folder: NamedFolder, name: string): string {
	return folder.path.slice(0, folder.path.length - folder.name.length) + name;
}

/**
 * Whether the folder at `path` is `folder` or one of its subfolders. A nested entry's delimiter is
 * the character before its name, so `Projects2/Notes` is not inside `Projects`.
 */
export function isWithin(path: string, folder: NamedFolder, entries: NamedFolder[]): boolean {
	if (path === folder.path) return true;
	const entry = entries.find((e) => e.path === path);
	if (!entry || entry.depth <= folder.depth) return false;
	const delimiter = entry.path.charAt(entry.path.length - entry.name.length - 1);
	return entry.path.startsWith(folder.path + delimiter);
}
