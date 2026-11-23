// Shows moved code in the diffs this extension opens: dimmed, in two alternating colors, with
// where it went or came from at the end of each block's first line.
import * as vscode from 'vscode';
import type { FileNode } from '../views/nodes';
import { type MoveAnnotation, lineSpan } from './annotate';

export type Side = 'left' | 'right';

export interface DecoratedSide {
	side: Side;
	annotations: MoveAnnotation[];
	/** the file whose diff this is a side of */
	node: FileNode;
	/** this side's document, and the other side's */
	uri: string;
	otherUri: string;
}

/** The diff tabs in front, one per editor group at most. */
function diffsInFront(): { original: string; modified: string; viewColumn: vscode.ViewColumn }[] {
	const pairs = [];
	for (const group of vscode.window.tabGroups.all) {
		const input = group.activeTab?.input;
		if (input instanceof vscode.TabInputTextDiff) {
			pairs.push({ original: input.original.toString(), modified: input.modified.toString(), viewColumn: group.viewColumn });
		}
	}
	return pairs;
}

export class MoveDecorator implements vscode.Disposable {
	// by document, then by the document on the other side: a working-tree file can be the
	// right side of several comparisons at once
	private readonly sides = new Map<string, Map<string, DecoratedSide>>();
	private readonly dim: vscode.TextEditorDecorationType[];
	private readonly label: vscode.TextEditorDecorationType;
	private readonly subscriptions: vscode.Disposable[];
	private on = true;

	constructor() {
		this.dim = ['betterdiff.movedBackground', 'betterdiff.movedAlternateBackground'].map((color) => vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor(color),
			opacity: '0.55',
			overviewRulerColor: new vscode.ThemeColor(color),
			overviewRulerLane: vscode.OverviewRulerLane.Center,
		}));
		this.label = vscode.window.createTextEditorDecorationType({
			after: { color: new vscode.ThemeColor('betterdiff.movedLabelForeground'), fontStyle: 'italic', margin: '0 0 0 3ch' },
		});
		this.subscriptions = [
			...this.dim, this.label,
			vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
			vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
		];
	}

	set enabled(on: boolean) {
		this.on = on;
		this.refresh();
	}

	/** Records what the two sides of a diff show, and draws it if the diff is in front. */
	register(left: vscode.Uri, right: vscode.Uri, node: FileNode, leftAnnotations: MoveAnnotation[], rightAnnotations: MoveAnnotation[]): void {
		const l = left.toString();
		const r = right.toString();
		const put = (side: DecoratedSide) => {
			const byOther = this.sides.get(side.uri) ?? new Map<string, DecoratedSide>();
			byOther.set(side.otherUri, side);
			this.sides.set(side.uri, byOther);
		};
		put({ side: 'left', annotations: leftAnnotations, node, uri: l, otherUri: r });
		put({ side: 'right', annotations: rightAnnotations, node, uri: r, otherUri: l });
		this.refresh();
	}

	/** Forgets the diffs that no tab shows any more. */
	prune(isOpen: (left: string, right: string) => boolean): void {
		for (const [uri, byOther] of this.sides) {
			for (const [other, side] of byOther) {
				if (!(side.side === 'left' ? isOpen(uri, other) : isOpen(other, uri))) {
					byOther.delete(other);
				}
			}
			if (byOther.size === 0) {
				this.sides.delete(uri);
			}
		}
	}

	/** What `editor` shows, when it is a side of one of our diffs and that diff is in front. */
	sideOf(editor: vscode.TextEditor): DecoratedSide | undefined {
		const byOther = this.sides.get(editor.document.uri.toString());
		if (!byOther) {
			return undefined;
		}
		for (const pair of diffsInFront()) {
			// a diff editor's sides don't always report a column; a plain editor on the same
			// file in another group does, and it is left alone
			if (editor.viewColumn !== undefined && editor.viewColumn !== pair.viewColumn) {
				continue;
			}
			const side = byOther.get(pair.original) ?? byOther.get(pair.modified);
			if (side && (side.side === 'left' ? side.uri === pair.original && side.otherUri === pair.modified : side.uri === pair.modified && side.otherUri === pair.original)) {
				return side;
			}
		}
		return undefined;
	}

	/** A registered side by its two documents (what a hover's links carry). */
	lookup(uri: string, otherUri: string): DecoratedSide | undefined {
		return this.sides.get(uri)?.get(otherUri);
	}

	refresh(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.apply(editor);
		}
	}

	private apply(editor: vscode.TextEditor): void {
		const side = this.on ? this.sideOf(editor) : undefined;
		const dim: vscode.DecorationOptions[][] = [[], []];
		const labels: vscode.DecorationOptions[] = [];
		const lastLine = editor.document.lineCount;
		for (const a of side?.annotations ?? []) {
			if (a.start > lastLine) {
				continue;
			}
			const hoverMessage = hover(side!, a);
			// consecutive matched lines as one range
			const lines = a.matchedLines.filter((l) => l <= lastLine).sort((x, y) => x - y);
			for (let i = 0; i < lines.length;) {
				let j = i;
				while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) {
					j++;
				}
				dim[a.zebra].push({ range: new vscode.Range(lines[i] - 1, 0, lines[j] - 1, 0), hoverMessage });
				i = j + 1;
			}
			const end = editor.document.lineAt(a.start - 1).range.end;
			const where = `${a.other.path}:${lineSpan(a.other.start, a.other.count)}`;
			const text = side!.side === 'right' ? `⇠ moved from ${where}` : `⇢ moved to ${where}`;
			labels.push({ range: new vscode.Range(end, end), renderOptions: { after: { contentText: a.edited ? `${text} (edited)` : text } } });
		}
		editor.setDecorations(this.dim[0], dim[0]);
		editor.setDecorations(this.dim[1], dim[1]);
		editor.setDecorations(this.label, labels);
	}

	dispose(): void {
		for (const s of this.subscriptions) {
			s.dispose();
		}
	}
}

function hover(side: DecoratedSide, a: MoveAnnotation): vscode.MarkdownString {
	const args = encodeURIComponent(JSON.stringify([side.uri, side.otherUri, a.id]));
	const where = `\`${a.other.path}:${lineSpan(a.other.start, a.other.count)}\``;
	const md = new vscode.MarkdownString(
		`${side.side === 'right' ? 'Moved from' : 'Moved to'} ${where}${a.edited ? ', with edits (the lines not dimmed)' : ''}\n\n` +
		`[${side.side === 'right' ? 'Go to where it was' : 'Go to where it went'}](command:betterdiff.goToMove?${args}) · [Compare the two blocks](command:betterdiff.compareMove?${args})`,
	);
	md.isTrusted = { enabledCommands: ['betterdiff.goToMove', 'betterdiff.compareMove'] };
	return md;
}
