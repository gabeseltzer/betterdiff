// What the trees are made of, and how each node finds its children. No vscode import.
import { type Folder, buildFileTree } from '../fileTree';
import type { Git } from '../git/exec';
import type { PullRequest } from '../git/github';
import { type Commit, type Comparison, type FileChange, WORKING_TREE, changedFiles, commitComparison, commitsBetween, isDirty } from '../git/model';
import type { MoveIndex } from '../moves/annotate';

interface NodeBase {
	/** stable across refreshes, so the tree keeps what was expanded */
	id: string;
	parent?: Node;
	children?: Promise<Node[]>;
}

/** A line of text: an empty state, or something that couldn't be worked out. */
export interface MessageNode extends NodeBase {
	kind: 'message';
	label: string;
	description?: string;
	icon?: string;
	command?: { command: string; title: string };
}

/** Things with changed files under them. */
interface Owner extends NodeBase {
	git: Git;
	root: string;
	cmp: Comparison;
	/** every file under it, in the order the tree lists them (set once loaded) */
	files?: FileNode[];
	/** the code that moved in it (set once computed) */
	moves?: MoveIndex;
}

export interface ComparisonNode extends Owner {
	kind: 'comparison';
	label: string;
	description?: string;
	tooltip?: string;
	icon: string;
	contextValue?: string;
	expanded?: boolean;
	/** list this range's commits in a group above the files */
	commits?: { base: string; head: string };
	pr?: PullRequest;
	/** Next / Previous File stay inside it */
	scope?: boolean;
}

export interface GroupNode extends NodeBase {
	kind: 'group';
	label: string;
	git: Git;
	root: string;
	range: { base: string; head: string };
	scope: true;
}

export interface CommitNode extends Owner {
	kind: 'commit';
	commit: Commit;
}

export interface FolderNode extends NodeBase {
	kind: 'folder';
	folder: Folder<FileChange>;
	owner: ComparisonNode | CommitNode;
}

export interface FileNode extends NodeBase {
	kind: 'file';
	change: FileChange;
	owner: ComparisonNode | CommitNode;
}

export type Node = MessageNode | ComparisonNode | GroupNode | CommitNode | FolderNode | FileNode;

export interface Settings {
	layout: 'tree' | 'list';
	commitsOrder: 'oldestFirst' | 'newestFirst';
	includeWorkingTree: boolean;
}

export const message = (id: string, label: string, extra: Partial<MessageNode> = {}): MessageNode => ({ kind: 'message', id, label, ...extra });

/** The commits of a range as nodes, in the configured order. */
export async function commitNodes(git: Git, root: string, range: { base: string; head: string }, idPrefix: string, settings: Settings, parent?: Node): Promise<CommitNode[]> {
	const commits = await commitsBetween(git, range.base, range.head);
	if (settings.commitsOrder === 'newestFirst') {
		commits.reverse();
	}
	return commits.map((commit) => ({ kind: 'commit', id: `${idPrefix}/commit:${commit.sha}`, parent, git, root, commit, cmp: commitComparison(commit) }));
}

/** "Uncommitted changes" as the last step of a walk through commits; undefined when there are none. */
export async function uncommittedNode(git: Git, root: string, headSha: string, headLabel: string, idPrefix: string, parent?: Node): Promise<ComparisonNode | undefined> {
	if (!await isDirty(git)) {
		return undefined;
	}
	return {
		kind: 'comparison', id: `${idPrefix}/uncommitted`, parent, git, root, label: 'Uncommitted changes', icon: 'edit',
		cmp: { base: headSha, head: WORKING_TREE, baseLabel: headLabel, headLabel: 'working tree' },
	};
}

function fileNodes(owner: ComparisonNode | CommitNode, changes: FileChange[], layout: Settings['layout']): Node[] {
	const file = (change: FileChange, parent: Node): FileNode => ({ kind: 'file', id: `${owner.id}/file:${change.path}`, parent, change, owner });
	if (layout === 'list') {
		const nodes = changes.map((c) => file(c, owner));
		owner.files = nodes;
		return nodes;
	}
	const all: FileNode[] = [];
	const under = (folder: Folder<FileChange>, parent: Node): Node[] => [
		...folder.folders.map((f) => {
			const node: FolderNode = { kind: 'folder', id: `${owner.id}/folder:${f.path}`, parent, folder: f, owner };
			node.children = Promise.resolve(under(f, node));
			return node;
		}),
		...folder.files.map((c) => {
			const node = file(c, parent);
			all.push(node);
			return node;
		}),
	];
	const nodes = under(buildFileTree(changes, (c) => c.path), owner);
	owner.files = all;
	return nodes;
}

async function load(node: Node, settings: Settings): Promise<Node[]> {
	switch (node.kind) {
		case 'comparison':
		case 'commit': {
			const changes = await changedFiles(node.git, node.cmp.base, node.cmp.head);
			const files = fileNodes(node, changes, settings.layout);
			const nodes: Node[] = [];
			if (node.kind === 'comparison' && node.commits) {
				nodes.push({ kind: 'group', id: `${node.id}/commits`, parent: node, label: 'Commits', git: node.git, root: node.root, range: node.commits, scope: true });
			}
			if (files.length === 0) {
				nodes.push(message(`${node.id}/empty`, 'No changes', { parent: node }));
			}
			return [...nodes, ...files];
		}
		case 'group': {
			const commits = await commitNodes(node.git, node.root, node.range, node.id, settings, node);
			return commits.length ? commits : [message(`${node.id}/empty`, 'No commits', { parent: node })];
		}
		default:
			return [];
	}
}

/** A node's children, loaded once. */
export function childrenOf(node: Node, settings: Settings): Promise<Node[]> {
	node.children ??= load(node, settings).catch((e: unknown) => [message(`${node.id}/error`, e instanceof Error ? e.message : String(e), { parent: node, icon: 'error' })]);
	return node.children;
}

export type Direction = 1 | -1;

/** The first file at or under `node` (the last, going backwards). Groups are entered only from inside. */
export async function firstFile(node: Node, dir: Direction, settings: Settings): Promise<FileNode | undefined> {
	if (node.kind === 'file') {
		return node;
	}
	if (node.kind === 'message' || node.kind === 'group') {
		return undefined;
	}
	const children = await childrenOf(node, settings);
	for (const child of dir === 1 ? children : [...children].reverse()) {
		const found = await firstFile(child, dir, settings);
		if (found) {
			return found;
		}
	}
	return undefined;
}

const isScope = (n: Node) => (n.kind === 'group' || n.kind === 'comparison') && n.scope === true;

/**
 * The file after `from` in the order the tree shows (before it, going backwards), expanding
 * what's on the way. It stays within the comparison or the list of commits `from` is in: from a
 * commit's last file it goes on to the next commit's first.
 */
export async function nextFile(from: Node, dir: Direction, roots: () => Promise<Node[]>, settings: Settings): Promise<FileNode | undefined> {
	for (let n = from; ;) {
		const siblings = n.parent ? await childrenOf(n.parent, settings) : await roots();
		const at = siblings.indexOf(n);
		const rest = dir === 1 ? siblings.slice(at + 1) : siblings.slice(0, Math.max(at, 0)).reverse();
		for (const sibling of rest) {
			const found = await firstFile(sibling, dir, settings);
			if (found) {
				return found;
			}
		}
		if (!n.parent || isScope(n.parent)) {
			return undefined;
		}
		n = n.parent;
	}
}

/**
 * The node with this id in a freshly loaded tree: how a node from before a refresh finds its
 * successor. Ids are paths (`stack/my-branch/file:src/a.ts`), so the way down follows prefixes.
 */
export async function locate(id: string, roots: () => Promise<Node[]>, settings: Settings): Promise<Node | undefined> {
	let level = await roots();
	for (; ;) {
		const exact = level.find((n) => n.id === id);
		if (exact) {
			return exact;
		}
		// the longest match: one branch's name can be the start of another's
		const on = level
			.filter((n) => id.startsWith(n.id + '/') || (n.kind === 'folder' && id.startsWith(`${n.owner.id}/file:${n.folder.path}/`)))
			.sort((a, b) => b.id.length - a.id.length)[0];
		if (!on) {
			return undefined;
		}
		level = await childrenOf(on, settings);
	}
}

/** The commit `node` is in (or the uncommitted changes at the end of a walk). */
export function stepOf(node: Node | undefined): CommitNode | ComparisonNode | undefined {
	for (let n = node; n; n = n.parent) {
		if (n.kind === 'commit' || (n.kind === 'comparison' && !n.scope)) {
			return n;
		}
	}
	return undefined;
}

/** The first file of the commit after the one `from` is in (before it, going backwards). */
export async function nextStep(from: Node, dir: Direction, roots: () => Promise<Node[]>, settings: Settings): Promise<FileNode | undefined> {
	const step = stepOf(from);
	if (!step) {
		return undefined;
	}
	const siblings = step.parent ? await childrenOf(step.parent, settings) : await roots();
	const at = siblings.indexOf(step);
	const rest = dir === 1 ? siblings.slice(at + 1) : siblings.slice(0, Math.max(at, 0)).reverse();
	for (const sibling of rest) {
		// always a step's first file, whichever way we go
		const found = await firstFile(sibling, 1, settings);
		if (found) {
			return found;
		}
	}
	return undefined;
}
