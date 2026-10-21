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

/**
 * Folders in tree order, each followed by its subfolders, with their depth in that tree. Roots
 * and siblings keep their order in `folders`. A folder whose parent is not listed (such as
 * Gmail's unselectable `[Gmail]`) is a root, so subfolders of role folders sit below them.
 */
export function nestFolders<T extends NamedFolder>(folders: T[]): { folder: T; depth: number }[] {
	const paths = new Set(folders.map((f) => f.path));
	const children = new Map<string | null, T[]>();
	for (const folder of folders) {
		const parent = folder.depth ? folder.path.slice(0, -folder.name.length - 1) : null;
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
