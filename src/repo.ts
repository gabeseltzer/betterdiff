// The workspace's git repositories: which one the views show, and when it changed.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Git, gitRunner, memoized, tryRun } from './git/exec';

export class Repositories implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	/** The active repository changed: a checkout, a commit, a fetch, a saved file. Debounced. */
	readonly onDidChange = this.changed.event;

	private rootList: string[] = [];
	private activeRoot: string | undefined;
	private memo: Git | undefined;
	private watchers: vscode.Disposable[] = [];
	private timer: NodeJS.Timeout | undefined;
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(private readonly memento: vscode.Memento) {
		this.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (this.activeRoot && doc.uri.scheme === 'file' && isInside(this.activeRoot, doc.uri.fsPath)) {
					this.touch();
				}
			}),
			vscode.workspace.onDidCreateFiles(() => this.touch()),
			vscode.workspace.onDidDeleteFiles(() => this.touch()),
			vscode.workspace.onDidRenameFiles(() => this.touch()),
		);
	}

	get roots(): readonly string[] {
		return this.rootList;
	}

	get active(): string | undefined {
		return this.activeRoot;
	}

	private get gitPath(): string {
		const configured = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
		return (Array.isArray(configured) ? configured[0] : configured) || 'git';
	}

	/** git in `root`, uncached. */
	git(root: string): Git {
		return gitRunner(root, this.gitPath);
	}

	/**
	 * git in the active repository. A repeated command is answered from memory until the next
	 * change, so the three views share what they ask.
	 */
	session(): Git | undefined {
		if (!this.activeRoot) {
			return undefined;
		}
		this.memo ??= memoized(this.git(this.activeRoot));
		return this.memo;
	}

	/** Finds the repositories of the workspace folders. */
	async discover(): Promise<void> {
		const found: string[] = [];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') {
				continue;
			}
			const top = (await tryRun(this.git(folder.uri.fsPath), ['rev-parse', '--show-toplevel']))?.trim();
			if (top && !found.some((r) => samePath(r, top))) {
				found.push(path.normalize(top));
			}
		}
		this.rootList = found;
		const remembered = this.memento.get<string>('betterdiff.repository');
		const next = found.find((r) => remembered && samePath(r, remembered)) ?? found[0];
		void vscode.commands.executeCommand('setContext', 'betterdiff.noRepository', found.length === 0);
		void vscode.commands.executeCommand('setContext', 'betterdiff.multipleRepositories', found.length > 1);
		await this.activate(next);
	}

	async select(root: string): Promise<void> {
		await this.memento.update('betterdiff.repository', root);
		await this.activate(root);
	}

	private async activate(root: string | undefined): Promise<void> {
		this.activeRoot = root;
		this.disposeWatchers();
		if (root) {
			await this.watch(root);
		}
		this.invalidate();
	}

	// HEAD moves on a checkout or a commit; refs change on a commit, a fetch or a push.
	private async watch(root: string): Promise<void> {
		const git = this.git(root);
		const gitDir = (await tryRun(git, ['rev-parse', '--absolute-git-dir']))?.trim();
		const commonDir = (await tryRun(git, ['rev-parse', '--path-format=absolute', '--git-common-dir']))?.trim() || gitDir;
		if (!gitDir || !commonDir || this.activeRoot !== root) {
			return;
		}
		const patterns: [string, string][] = [[gitDir, 'HEAD'], [commonDir, 'packed-refs'], [commonDir, 'refs/**']];
		for (const [dir, glob] of patterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
			this.watchers.push(watcher, watcher.onDidChange(() => this.touch()), watcher.onDidCreate(() => this.touch()), watcher.onDidDelete(() => this.touch()));
		}
	}

	/** Something changed: forget what git said, and tell the views, once things settle. */
	touch(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.invalidate(), 400);
	}

	/** Forget what git said and tell the views now. */
	invalidate(): void {
		clearTimeout(this.timer);
		this.memo = undefined;
		this.changed.fire();
	}

	private disposeWatchers(): void {
		for (const w of this.watchers) {
			w.dispose();
		}
		this.watchers = [];
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.disposeWatchers();
		for (const s of this.subscriptions) {
			s.dispose();
		}
		this.changed.dispose();
	}
}

const fold = (p: string) => {
	const n = path.normalize(p).replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? n.toLowerCase() : n;
};

/** The same folder, however it's written (`c:\x` and `C:/x` on Windows). */
export function samePath(a: string, b: string): boolean {
	return fold(a) === fold(b);
}

export function isInside(root: string, file: string): boolean {
	const r = fold(root);
	const f = fold(file);
	return f === r || f.startsWith(r + path.sep);
}
