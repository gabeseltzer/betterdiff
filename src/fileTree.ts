// Changed files as a folder tree. Pure.

export interface Folder<T> {
	/** the folder's name; several joined with / when each has nothing but the next in it */
	name: string;
	/** its path from the root */
	path: string;
	folders: Folder<T>[];
	files: T[];
}

/**
 * Groups `items` by the folders of their paths. Paths use `/`, and come sorted the way the tree
 * should list them. A chain of folders with one subfolder each and no files is compacted into
 * one node (`src/git/parsers`), as in the Explorer.
 */
export function buildFileTree<T>(items: readonly T[], pathOf: (item: T) => string): Folder<T> {
	const root: Folder<T> = { name: '', path: '', folders: [], files: [] };
	for (const item of items) {
		const parts = pathOf(item).split('/');
		let folder = root;
		for (const part of parts.slice(0, -1)) {
			let next = folder.folders.find((f) => f.name === part);
			if (!next) {
				next = { name: part, path: folder.path ? `${folder.path}/${part}` : part, folders: [], files: [] };
				folder.folders.push(next);
			}
			folder = next;
		}
		folder.files.push(item);
	}
	const compact = (folder: Folder<T>): Folder<T> => {
		let f = folder;
		while (f.files.length === 0 && f.folders.length === 1 && f !== root) {
			const only = f.folders[0];
			f = { ...only, name: `${f.name}/${only.name}` };
		}
		return { ...f, folders: f.folders.map(compact) };
	};
	return { ...root, folders: root.folders.map(compact) };
}
