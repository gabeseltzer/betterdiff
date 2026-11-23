import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContentProvider, SCHEME } from './content';
import { DiffOpener } from './diffOpener';
import { type PullRequest, openPullRequests } from './git/github';
import { tryRun } from './git/exec';
import { WORKING_TREE } from './git/model';
import type { MoveIndex } from './moves/annotate';
import { MoveDecorator } from './moves/decorator';
import { MovesService } from './moves/service';
import { Repositories } from './repo';
import { type CommitNode, type ComparisonNode, type Direction, type FileNode, type Node, type Settings, stepOf } from './views/nodes';
import { DiffTreeProvider, StatusDecorations } from './views/provider';
import { type RootContext, branchRoots, commitRoots, stackRoots } from './views/roots';

const PR_CACHE_MS = 5 * 60 * 1000;

const config = () => vscode.workspace.getConfiguration('betterdiff');

function settings(): Settings {
	const c = config();
	return {
		layout: c.get<Settings['layout']>('fileLayout', 'tree'),
		commitsOrder: c.get<Settings['commitsOrder']>('commits.order', 'oldestFirst'),
		includeWorkingTree: c.get('includeWorkingTree', true),
	};
}

export interface Api {
	/** for the integration tests */
	readonly views: Record<'branch' | 'stack' | 'commits', DiffTreeProvider>;
	readonly opener: DiffOpener;
	readonly decorator: MoveDecorator;
	refresh(): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<Api> {
	const repos = new Repositories(context.workspaceState);
	const moves = new MovesService();
	const content = new ContentProvider((root) => repos.git(root));
	const decorator = new MoveDecorator();
	decorator.enabled = config().get('moves.enabled', true);

	const movesFor = async (owner: ComparisonNode | CommitNode): Promise<MoveIndex | undefined> => {
		const c = config();
		if (!c.get('moves.enabled', true)) {
			return undefined;
		}
		const index = await moves.get(repos.git(owner.root), owner.cmp.base, owner.cmp.head, {
			minLines: c.get('moves.minLines', 3),
			minAlnum: c.get('moves.minCharacters', 20),
			lookahead: c.get('moves.bridgeLines', 2),
		});
		owner.moves = index;
		return index;
	};
	const opener = new DiffOpener(content, decorator, movesFor);

	// open pull requests per repository, asked for at most every few minutes
	const prCache = new Map<string, { at: number; prs: Promise<PullRequest[] | undefined> }>();
	const pullRequests = (root: string) => {
		if (!config().get('stack.useGitHubCli', true)) {
			return Promise.resolve(undefined);
		}
		let hit = prCache.get(root);
		if (!hit || Date.now() - hit.at > PR_CACHE_MS) {
			hit = { at: Date.now(), prs: openPullRequests(root) };
			prCache.set(root, hit);
		}
		return hit.prs;
	};

	const rootsWith = (build: (ctx: RootContext) => Promise<Node[]>) => async (): Promise<Node[]> => {
		const git = repos.session();
		const root = repos.active;
		if (!git || !root) {
			return [];
		}
		const resource = vscode.Uri.file(root);
		return build({
			git, root, settings: settings(),
			baseBranch: vscode.workspace.getConfiguration('betterdiff', resource).get('baseBranch', ''),
			pullRequests: () => pullRequests(root),
		});
	};
	const host = { settings, movesFor };
	const providers = {
		branch: new DiffTreeProvider(rootsWith(branchRoots), host),
		stack: new DiffTreeProvider(rootsWith(stackRoots), host),
		commits: new DiffTreeProvider(rootsWith(commitRoots), host),
	};
	const views = {
		branch: vscode.window.createTreeView('betterdiff.branch', { treeDataProvider: providers.branch, showCollapseAll: true }),
		stack: vscode.window.createTreeView('betterdiff.stack', { treeDataProvider: providers.stack, showCollapseAll: true }),
		commits: vscode.window.createTreeView('betterdiff.commits', { treeDataProvider: providers.commits, showCollapseAll: true }),
	};
	const viewKeys = Object.keys(providers) as (keyof typeof providers)[];

	const refreshViews = () => {
		moves.forgetWorkingTree();
		for (const key of viewKeys) {
			providers[key].refresh();
		}
		const name = repos.active && repos.roots.length > 1 ? path.basename(repos.active) : undefined;
		views.branch.description = name;
	};

	// Nodes are rebuilt on every refresh, so a diff opened earlier holds an old one: find it
	// again by its id, which starts with the view it is in.
	const current = async (node: FileNode | undefined) => {
		const key = viewKeys.find((k) => node?.id.startsWith(k + '/'));
		const fresh = node && key ? await providers[key].locate(node.id) : undefined;
		return key && fresh ? { key, node: fresh } : undefined;
	};

	const open = async (node: FileNode, announceStep: boolean) => {
		await opener.show(node);
		const at = await current(node);
		if (at && views[at.key].visible) {
			await Promise.resolve(views[at.key].reveal(at.node, { select: true, focus: false })).catch(() => { });
		}
		const step = announceStep ? stepOf(node) : undefined;
		if (step) {
			vscode.window.setStatusBarMessage(step.kind === 'commit' ? `$(git-commit) ${step.commit.short} ${step.commit.subject}` : `$(edit) ${step.label}`, 5000);
		}
	};

	// Next / Previous: from the diff in front, in the view it was opened from.
	const move = async (dir: Direction, byCommit: boolean) => {
		const from = await current(opener.active());
		const step = stepOf(from?.node);
		let next: FileNode | undefined;
		if (byCommit && !step) {
			// not in a commit yet: start the walk
			next = await providers.commits.firstFile();
		} else if (from) {
			next = byCommit ? await providers[from.key].nextStep(from.node, dir) : await providers[from.key].nextFile(from.node, dir);
		}
		if (!next) {
			vscode.window.setStatusBarMessage(byCommit ? (dir === 1 ? 'No next commit' : 'No previous commit') : (dir === 1 ? 'Last file' : 'First file'), 3000);
			return;
		}
		// say so when this lands in another commit
		await open(next, stepOf(next) !== step);
	};

	const toggle = async (key: string, values: [unknown, unknown]) => {
		const c = config();
		await c.update(key, c.get(key) === values[0] ? values[1] : values[0], vscode.ConfigurationTarget.Global);
	};

	context.subscriptions.push(
		repos, decorator, opener, ...Object.values(views),
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, content),
		vscode.window.registerFileDecorationProvider(new StatusDecorations()),
		repos.onDidChange(refreshViews),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('betterdiff')) {
				decorator.enabled = config().get('moves.enabled', true);
				refreshViews();
			}
		}),

		vscode.commands.registerCommand('betterdiff.refresh', async () => {
			prCache.clear();
			await repos.discover();
		}),
		vscode.commands.registerCommand('betterdiff.openFile', (node: FileNode) => opener.show(node, { preserveFocus: true })),
		vscode.commands.registerCommand('betterdiff.openWorkingFile', async (node: FileNode) => {
			const { change, owner } = node;
			if (change.status === 'D' && owner.cmp.head === WORKING_TREE) {
				return void vscode.window.showInformationMessage(`${change.path} was deleted.`);
			}
			await vscode.window.showTextDocument(vscode.Uri.file(path.join(owner.root, change.path)), { preview: true });
		}),
		vscode.commands.registerCommand('betterdiff.nextFile', () => move(1, false)),
		vscode.commands.registerCommand('betterdiff.previousFile', () => move(-1, false)),
		vscode.commands.registerCommand('betterdiff.nextCommit', () => move(1, true)),
		vscode.commands.registerCommand('betterdiff.previousCommit', () => move(-1, true)),
		vscode.commands.registerCommand('betterdiff.toggleFileLayout', () => toggle('fileLayout', ['tree', 'list'])),
		vscode.commands.registerCommand('betterdiff.toggleWorkingTree', () => toggle('includeWorkingTree', [true, false])),
		vscode.commands.registerCommand('betterdiff.toggleMoves', () => toggle('moves.enabled', [true, false])),
		vscode.commands.registerCommand('betterdiff.goToMove', (...args: unknown[]) => opener.goToMove(...args)),
		vscode.commands.registerCommand('betterdiff.compareMove', (...args: unknown[]) => opener.compareMove(...args)),
		vscode.commands.registerCommand('betterdiff.copySha', (node: CommitNode) => vscode.env.clipboard.writeText(node.commit.sha)),
		vscode.commands.registerCommand('betterdiff.openPullRequest', (node: ComparisonNode) => {
			if (node.pr?.url) {
				void vscode.env.openExternal(vscode.Uri.parse(node.pr.url));
			}
		}),
		vscode.commands.registerCommand('betterdiff.selectRepository', async () => {
			const picked = await vscode.window.showQuickPick(repos.roots.map((root) => ({ label: path.basename(root), description: root, root })), { placeHolder: 'Repository to show in Better Diff' });
			if (picked) {
				await repos.select(picked.root);
			}
		}),
		vscode.commands.registerCommand('betterdiff.setBaseBranch', async () => {
			const git = repos.session();
			if (!git || !repos.active) {
				return;
			}
			const refs = (await tryRun(git, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/remotes', 'refs/heads']) ?? '')
				.split('\n').map((r) => r.trim()).filter((r) => r && !r.endsWith('/HEAD'));
			const detect = { label: '$(sparkle) Detect', description: "the remote's default branch, then origin/master, origin/main, master, main", ref: '' };
			const picked = await vscode.window.showQuickPick([detect, ...refs.map((ref) => ({ label: ref, description: '', ref }))], { placeHolder: 'Branch to compare the current branch with (at their merge base)' });
			if (picked) {
				const scoped = vscode.workspace.getConfiguration('betterdiff', vscode.Uri.file(repos.active));
				await scoped.update('baseBranch', picked.ref || undefined, vscode.ConfigurationTarget.Workspace);
			}
		}),
	);

	await repos.discover();
	return { views: providers, opener, decorator, refresh: () => repos.discover() };
}

export function deactivate(): void { }
