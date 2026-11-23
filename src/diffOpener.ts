// Opens a changed file as a side-by-side diff, and knows which of our diffs is in front.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type ContentProvider, emptyUri, revUri } from './content';
import { WORKING_TREE } from './git/model';
import { type MoveIndex, annotationAt, lineSpan } from './moves/annotate';
import type { DecoratedSide, MoveDecorator, Side } from './moves/decorator';
import type { CommitNode, ComparisonNode, FileNode } from './views/nodes';

export interface ShowOptions {
	preserveFocus?: boolean;
	/** put the cursor on this line (1-based) of one side */
	reveal?: { side: Side; line: number };
}

const pairKey = (left: vscode.Uri | string, right: vscode.Uri | string) => `${left.toString()}\n${right.toString()}`;

// What the built-in Git extension serves a file at a revision under: it knows how to show images
// and other binaries, which our own text documents can't.
const gitUri = (file: string, ref: string) => vscode.Uri.from({ scheme: 'git', path: vscode.Uri.file(file).path, query: JSON.stringify({ path: file, ref }) });

export class DiffOpener implements vscode.Disposable {
	private readonly shown = new Map<string, FileNode>();
	private readonly subscriptions: vscode.Disposable[];
	private readonly changedActive = new vscode.EventEmitter<FileNode | undefined>();
	/** Another of our diffs came to the front (or none is any more). */
	readonly onDidChangeActive = this.changedActive.event;

	constructor(
		private readonly content: ContentProvider,
		private readonly decorator: MoveDecorator,
		private readonly movesFor: (owner: ComparisonNode | CommitNode) => Promise<MoveIndex | undefined>,
	) {
		this.subscriptions = [
			this.changedActive,
			vscode.window.tabGroups.onDidChangeTabs(() => this.tabsChanged()),
			vscode.window.tabGroups.onDidChangeTabGroups(() => this.tabsChanged()),
		];
	}

	/** The two documents of a file's diff, and the tab's title. */
	sides(node: FileNode): { left: vscode.Uri; right: vscode.Uri; title: string } {
		const { change, owner } = node;
		const { root, cmp } = owner;
		const basePath = change.oldPath ?? change.path;
		const file = path.join(root, change.path);
		const added = change.status === 'A' || change.status === '?';
		const onDisk = cmp.head === WORKING_TREE;
		let left: vscode.Uri;
		let right: vscode.Uri;
		if (change.binary) {
			left = gitUri(path.join(root, basePath), cmp.base);
			right = onDisk ? vscode.Uri.file(file) : gitUri(file, cmp.head);
		} else {
			left = added ? emptyUri(root, basePath, cmp.head) : revUri(root, cmp.base, basePath, cmp.head);
			right = change.status === 'D' ? emptyUri(root, change.path, cmp.base) : onDisk ? vscode.Uri.file(file) : revUri(root, cmp.head, change.path, cmp.base);
		}
		return { left, right, title: `${path.basename(change.path)} (${cmp.baseLabel} ↔ ${cmp.headLabel})` };
	}

	async show(node: FileNode, options: ShowOptions = {}): Promise<void> {
		const { left, right, title } = this.sides(node);
		this.shown.set(pairKey(left, right), node);
		const line = options.reveal?.side === 'right' ? options.reveal.line : undefined;
		await vscode.commands.executeCommand('vscode.diff', left, right, title, {
			preview: true,
			preserveFocus: options.preserveFocus,
			selection: line === undefined ? undefined : new vscode.Range(line - 1, 0, line - 1, 0),
		} satisfies vscode.TextDocumentShowOptions);
		// again: tab events while the diff was opening pruned what no tab showed yet
		this.shown.set(pairKey(left, right), node);
		if (options.reveal?.side === 'left') {
			const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === left.toString());
			if (editor) {
				const at = new vscode.Position(Math.min(options.reveal.line, editor.document.lineCount) - 1, 0);
				editor.selection = new vscode.Selection(at, at);
				editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			}
		}
		this.tabsChanged();
		// the diff is up; moved code is marked when it's known
		const { change, owner } = node;
		void this.movesFor(owner).then((moves) => {
			if (moves && this.shown.get(pairKey(left, right)) === node) {
				this.decorator.register(left, right, node, moves.left.get(change.oldPath ?? change.path) ?? [], moves.right.get(change.path) ?? []);
			}
		}, () => { });
	}

	/** The file whose diff is in front in the active editor group. */
	active(): FileNode | undefined {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		return input instanceof vscode.TabInputTextDiff ? this.shown.get(pairKey(input.original, input.modified)) : undefined;
	}

	private lastActive: FileNode | undefined;

	private tabsChanged(): void {
		const open = new Set<string>();
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputTextDiff) {
					open.add(pairKey(tab.input.original, tab.input.modified));
				}
			}
		}
		for (const key of [...this.shown.keys()]) {
			if (!open.has(key)) {
				this.shown.delete(key);
			}
		}
		this.decorator.prune((l, r) => open.has(pairKey(l, r)));
		const active = this.active();
		void vscode.commands.executeCommand('setContext', 'betterdiff.diffActive', active !== undefined);
		if (active !== this.lastActive) {
			this.lastActive = active;
			this.changedActive.fire(active);
		}
	}

	// A move the cursor is in, or the one a hover's link names: [document, other document, move id].
	private moveAt(args: unknown[]): { side: DecoratedSide; annotation: NonNullable<ReturnType<typeof annotationAt>> } | undefined {
		if (typeof args[0] === 'string' && typeof args[1] === 'string' && typeof args[2] === 'number') {
			const side = this.decorator.lookup(args[0], args[1]);
			const annotation = side?.annotations.find((a) => a.id === args[2]);
			return side && annotation ? { side, annotation } : undefined;
		}
		const editor = vscode.window.activeTextEditor;
		const side = editor && this.decorator.sideOf(editor);
		const annotation = side && annotationAt(side.annotations, editor.selection.active.line + 1);
		return side && annotation ? { side, annotation } : undefined;
	}

	/** Opens the diff of the file a block moved to or from, at that block. */
	async goToMove(...args: unknown[]): Promise<void> {
		const found = this.moveAt(args);
		if (!found) {
			void vscode.window.showInformationMessage('The cursor is not in moved code.');
			return;
		}
		const { side, annotation } = found;
		const otherSide: Side = side.side === 'right' ? 'left' : 'right';
		const target = (side.node.owner.files ?? []).find(({ change }) => otherSide === 'left'
			? change.status !== 'A' && change.status !== '?' && (change.oldPath ?? change.path) === annotation.other.path
			: change.status !== 'D' && change.path === annotation.other.path);
		if (!target) {
			void vscode.window.showWarningMessage(`${annotation.other.path} is not in this comparison any more.`);
			return;
		}
		await this.show(target, { reveal: { side: otherSide, line: annotation.other.start } });
	}

	/** A diff of just the block, before and after the move: the edits made on the way. */
	async compareMove(...args: unknown[]): Promise<void> {
		const found = this.moveAt(args);
		const move = found && found.side.node.owner.moves?.moves[found.annotation.id];
		if (!move) {
			void vscode.window.showInformationMessage('The cursor is not in moved code.');
			return;
		}
		const { source, dest } = move;
		const left = this.content.blockUri(source.path, source.lines.join('\n') + '\n');
		const right = this.content.blockUri(dest.path, dest.lines.join('\n') + '\n');
		const title = `Moved: ${path.basename(source.path)}:${lineSpan(source.start, source.lines.length)} ↔ ${path.basename(dest.path)}:${lineSpan(dest.start, dest.lines.length)}`;
		await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
	}

	dispose(): void {
		for (const s of this.subscriptions) {
			s.dispose();
		}
	}
}
