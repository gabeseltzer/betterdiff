// A view: its roots come from views/roots.ts, everything below from views/nodes.ts.
import * as vscode from 'vscode';
import { type MoveIndex, movedLineCount } from '../moves/annotate';
import type { FileChange, Status } from '../git/model';
import { type CommitNode, type ComparisonNode, type Direction, type FileNode, type Node, type Settings, childrenOf, firstFile, locate, message, nextFile, nextStep } from './nodes';

/** File rows get their status letter and color from this scheme, not from the file on disk. */
export const STATUS_SCHEME = 'betterdiff-status';

const STATUS: Record<Status, { letter: string; color: string; text: string }> = {
	'A': { letter: 'A', color: 'gitDecoration.addedResourceForeground', text: 'Added' },
	'M': { letter: 'M', color: 'gitDecoration.modifiedResourceForeground', text: 'Modified' },
	'D': { letter: 'D', color: 'gitDecoration.deletedResourceForeground', text: 'Deleted' },
	'R': { letter: 'R', color: 'gitDecoration.renamedResourceForeground', text: 'Renamed' },
	'C': { letter: 'C', color: 'gitDecoration.renamedResourceForeground', text: 'Copied' },
	'T': { letter: 'T', color: 'gitDecoration.modifiedResourceForeground', text: 'Type changed' },
	'U': { letter: 'U', color: 'gitDecoration.conflictingResourceForeground', text: 'Conflict' },
	'?': { letter: 'U', color: 'gitDecoration.untrackedResourceForeground', text: 'Untracked' },
};

export class StatusDecorations implements vscode.FileDecorationProvider {
	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== STATUS_SCHEME) {
			return undefined;
		}
		const s = STATUS[uri.query as Status];
		return s && { badge: s.letter, color: new vscode.ThemeColor(s.color), tooltip: s.text };
	}
}

export interface ProviderHost {
	settings(): Settings;
	/** Starts computing an owner's moves; resolves with them, or undefined when moves are off. */
	movesFor(owner: ComparisonNode | CommitNode): Promise<MoveIndex | undefined>;
}

export class DiffTreeProvider implements vscode.TreeDataProvider<Node> {
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private rootNodes: Promise<Node[]> | undefined;

	constructor(private readonly loadRoots: () => Promise<Node[]>, private readonly host: ProviderHost) { }

	refresh(): void {
		this.rootNodes = undefined;
		this.changed.fire(undefined);
	}

	roots = (): Promise<Node[]> => {
		this.rootNodes ??= this.loadRoots().catch((e: unknown) => [message('error', e instanceof Error ? e.message : String(e), { icon: 'error' })]);
		return this.rootNodes;
	};

	getParent(node: Node): Node | undefined {
		return node.parent;
	}

	async getChildren(node?: Node): Promise<Node[]> {
		if (!node) {
			return this.roots();
		}
		const children = await childrenOf(node, this.host.settings());
		if ((node.kind === 'comparison' || node.kind === 'commit') && node.moves === undefined) {
			// the file rows say how much of each file only moved, once that's known
			void this.host.movesFor(node).then((moves) => {
				if (moves && node.moves !== moves) {
					node.moves = moves;
					if (moves.moves.length) {
						this.changed.fire(node);
					}
				}
			}, () => { });
		}
		return children;
	}

	nextFile(from: Node, dir: Direction): Promise<FileNode | undefined> {
		return nextFile(from, dir, this.roots, this.host.settings());
	}

	nextStep(from: Node, dir: Direction): Promise<FileNode | undefined> {
		return nextStep(from, dir, this.roots, this.host.settings());
	}

	/** The first file of the view's first commit or comparison that has one. */
	async firstFile(): Promise<FileNode | undefined> {
		for (const root of await this.roots()) {
			const file = await firstFile(root, 1, this.host.settings());
			if (file) {
				return file;
			}
		}
		return undefined;
	}

	/** The node with this id as the view has it now (nodes are rebuilt on every refresh). */
	locate(id: string): Promise<Node | undefined> {
		return locate(id, this.roots, this.host.settings());
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const { None, Collapsed, Expanded } = vscode.TreeItemCollapsibleState;
		switch (node.kind) {
			case 'message': {
				const item = new vscode.TreeItem(node.label, None);
				item.id = node.id;
				item.description = node.description;
				item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
				item.command = node.command;
				return item;
			}
			case 'comparison': {
				const item = new vscode.TreeItem(node.label, node.expanded ? Expanded : Collapsed);
				item.id = node.id;
				item.description = node.description;
				item.tooltip = node.tooltip;
				item.iconPath = new vscode.ThemeIcon(node.icon);
				item.contextValue = node.contextValue ?? 'betterdiff.comparison';
				return item;
			}
			case 'group': {
				const item = new vscode.TreeItem(node.label, Collapsed);
				item.id = node.id;
				item.iconPath = new vscode.ThemeIcon('git-commit');
				return item;
			}
			case 'commit': {
				const { commit } = node;
				const item = new vscode.TreeItem(commit.subject, Collapsed);
				item.id = node.id;
				item.description = `${commit.short} · ${commit.author} · ${ago(commit.date)}`;
				item.tooltip = `${commit.sha}\n${commit.author}, ${new Date(commit.date).toLocaleString()}\n\n${commit.subject}`;
				item.iconPath = new vscode.ThemeIcon(commit.parents.length > 1 ? 'git-merge' : 'git-commit');
				item.contextValue = 'betterdiff.commit';
				return item;
			}
			case 'folder': {
				const item = new vscode.TreeItem(node.folder.name, Expanded);
				item.id = node.id;
				item.resourceUri = vscode.Uri.from({ scheme: STATUS_SCHEME, path: '/' + node.folder.path });
				item.iconPath = vscode.ThemeIcon.Folder;
				return item;
			}
			case 'file': {
				const { change, owner } = node;
				const slash = change.path.lastIndexOf('/');
				const item = new vscode.TreeItem(change.path.slice(slash + 1), None);
				item.id = node.id;
				item.resourceUri = vscode.Uri.from({ scheme: STATUS_SCHEME, path: '/' + change.path, query: change.status });
				const inList = this.host.settings().layout === 'list';
				item.description = [inList && slash > 0 && change.path.slice(0, slash), describe(change, owner.moves)].filter(Boolean).join(' · ') || undefined;
				item.tooltip = [change.path, change.oldPath && `${STATUS[change.status].text.toLowerCase()} from ${change.oldPath}`].filter(Boolean).join('\n');
				item.contextValue = 'betterdiff.file';
				item.command = { command: 'betterdiff.openFile', title: 'Open Changes', arguments: [node] };
				return item;
			}
		}
	}
}

function describe(change: FileChange, moves: MoveIndex | undefined): string {
	const parts: string[] = [];
	if (change.oldPath) {
		parts.push(`← ${change.oldPath.slice(change.oldPath.lastIndexOf('/') + 1)}`);
	}
	if (change.binary) {
		parts.push('binary');
	} else if (change.added !== undefined) {
		parts.push(`+${change.added} −${change.deleted ?? 0}`);
	}
	const moved = moves ? movedLineCount(moves, change.path, change.oldPath) : 0;
	if (moved) {
		parts.push(`⇄ ${moved} moved`);
	}
	return parts.join(' ');
}

function ago(iso: string): string {
	const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
	const units: [number, string][] = [[365 * 86400, 'y'], [30 * 86400, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
	for (const [size, unit] of units) {
		if (seconds >= size) {
			return `${Math.floor(seconds / size)}${unit} ago`;
		}
	}
	return 'just now';
}
