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
