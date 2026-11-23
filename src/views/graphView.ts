// The Commits view: a webview that draws the stack's commits as a graph (media/graph.js). The
// commits and their files are the nodes of the `commits` provider, which has no tree of its own:
// the webview names them by id.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { MoveIndex } from '../moves/annotate';
import { type RowModel, graphRows } from './graph';
import { type CommitNode, type ComparisonNode, type FileNode, type MessageNode, type Settings, childrenOf } from './nodes';
import { type DiffTreeProvider, STATUS, describe } from './provider';
import type { CommitGraph } from './roots';

export interface GraphHost {
	/** the graph to draw; undefined without a repository */
	graph(): Promise<CommitGraph | undefined>;
	/** the graph's commits as nodes */
	provider: DiffTreeProvider;
	settings(): Settings;
	movesFor(owner: ComparisonNode | CommitNode): Promise<MoveIndex | undefined>;
	open(file: FileNode): Promise<void>;
}

interface FileModel {
	id: string;
	name: string;
	description: string;
	tooltip: string;
	letter: string;
	status: string;
}

interface MessageModel {
	label: string;
	description?: string;
	command?: string;
}

type FromWebview =
	| { type: 'ready' }
	| { type: 'files'; id: string }
	| { type: 'open'; id: string }
	| { type: 'command'; command: string }
	| { type: 'rendered'; rows: number; files: number };

type ToWebview =
	| { type: 'model'; rows: RowModel[]; messages: MessageModel[] }
	| { type: 'files'; id: string; files: FileModel[] }
	| { type: 'select'; id: string; owner: string };

export class GraphView implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private generation = 0;
	/** the commands the messages on screen may run */
	private commands = new Set<string>();
	/** what the webview last drew (for the integration tests) */
	rendered: { rows: number; files: number } | undefined;

	constructor(private readonly extensionUri: vscode.Uri, private readonly host: GraphHost) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.onDidReceiveMessage((m: FromWebview) => void this.receive(m));
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
			}
		});
		const nonce = randomBytes(16).toString('hex');
		const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
		view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${uri('graph.css')}">
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
	<div id="list" role="tree" tabindex="0"></div>
	<script nonce="${nonce}" src="${uri('graph.js')}"></script>
</body>
</html>`;
	}

	/** The repository changed: draw the graph again. */
	refresh(): void {
		void this.postModel();
	}

	/** Shows `file` as the selected row, opening its commit. */
	select(file: FileNode): void {
		if (this.view?.visible) {
			this.post({ type: 'select', id: file.id, owner: file.owner.id });
		}
	}

	private post(message: ToWebview): void {
		void this.view?.webview.postMessage(message);
	}

	private async postModel(): Promise<void> {
		const generation = ++this.generation;
		let rows: RowModel[] = [];
		let said: MessageNode[] = [];
		try {
			const graph = await this.host.graph();
			if (!graph) {
				said = [{ kind: 'message', id: 'commits/no-repository', label: 'No git repository found in this workspace' }];
			} else if (graph.empty) {
				said = graph.empty;
			} else {
				rows = graphRows(graph);
			}
		} catch (e) {
			said = [{ kind: 'message', id: 'commits/error', label: e instanceof Error ? e.message : String(e) }];
		}
		if (generation !== this.generation) {
			return; // a newer one is on its way
		}
		this.commands = new Set(said.flatMap((m) => m.command?.command ?? []));
		this.post({ type: 'model', rows, messages: said.map((m) => ({ label: m.label, description: m.description, command: m.command?.command })) });
	}

	private async receive(message: FromWebview): Promise<void> {
		switch (message.type) {
			case 'ready':
				return this.postModel();
			case 'files':
				return this.postFiles(message.id);
			case 'open': {
				const node = await this.host.provider.locate(message.id);
				if (node?.kind === 'file') {
					await this.host.open(node);
				}
				return;
			}
			case 'command':
				if (this.commands.has(message.command)) {
					await vscode.commands.executeCommand(message.command);
				}
				return;
			case 'rendered':
				this.rendered = { rows: message.rows, files: message.files };
				return;
		}
	}

	/** The files a commit changed, and again once it's known which of their lines only moved. */
	private async postFiles(id: string): Promise<void> {
		const node = await this.host.provider.locate(id);
		if (node?.kind !== 'commit' && node?.kind !== 'comparison') {
			return this.post({ type: 'files', id, files: [] });
		}
		await childrenOf(node, this.host.settings());
		const send = () => this.post({ type: 'files', id, files: (node.files ?? []).map((f) => fileModel(f, node.moves)) });
		send();
		if (node.moves === undefined) {
			const moves = await this.host.movesFor(node).catch(() => undefined);
			if (moves?.moves.length) {
				node.moves = moves;
				send();
			}
		}
	}
}

function fileModel(file: FileNode, moves: MoveIndex | undefined): FileModel {
	const { change } = file;
	const slash = change.path.lastIndexOf('/');
	const status = STATUS[change.status];
	return {
		id: file.id,
		name: change.path.slice(slash + 1),
		description: [slash > 0 && change.path.slice(0, slash), describe(change, moves)].filter(Boolean).join(' · '),
		tooltip: [change.path, change.oldPath && `${status.text.toLowerCase()} from ${change.oldPath}`].filter(Boolean).join('\n'),
		letter: status.letter,
		status: change.status === '?' ? 'untracked' : change.status,
	};
}
