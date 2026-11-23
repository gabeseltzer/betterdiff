// Runs inside VS Code, in the stacked repository .vscode-test.mjs makes (feature-3 checked out).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Api } from '../../extension';
import type { ComparisonNode, FileNode, Node } from '../../views/nodes';

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (; ;) {
		const value = await probe();
		if (value !== undefined && value !== false) {
			return value;
		}
		if (Date.now() > end) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

const activeDiff = () => {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
	return tab?.input instanceof vscode.TabInputTextDiff ? { label: tab.label, original: tab.input.original, modified: tab.input.modified } : undefined;
};
const diffNamed = (start: string) => until(`a diff of ${start}`, () => {
	const diff = activeDiff();
	return diff?.label.startsWith(start) ? diff : undefined;
});
const editorOf = (uri: vscode.Uri) => until(`an editor on ${uri.path}`, () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()));

suite('Better Diff in VS Code', () => {
	let api: Api;
	const label = (n: Node) => (n.kind === 'commit' ? n.commit.subject : n.kind === 'folder' ? n.folder.name : n.kind === 'file' ? n.change.path : n.label);
	const fileIn = async (owner: Node, path: string, view: keyof Api['views']): Promise<FileNode> => {
		await api.views[view].getChildren(owner);
		const file = (owner as ComparisonNode).files!.find((f) => f.change.path === path);
		assert.ok(file, `${path} in ${label(owner)}`);
		return file;
	};

	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension<Api>('gabeseltzer.betterdiff');
		assert.ok(extension, 'the extension is installed');
		api = await extension.activate();
	});

	teardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

	test('the three views list the branch, its stack and its commits', async () => {
		assert.deepEqual((await api.views.branch.getChildren()).map(label), ['feature-3 ↔ origin/master', 'feature-3 is not on the remote']);
		assert.deepEqual((await api.views.stack.getChildren()).map(label).slice(0, 3), ['feature-3', 'feature-2', 'feature-1']);
		assert.deepEqual((await api.views.commits.getChildren()).map(label), ['one a', 'one b', 'one c', 'two a', 'three a']);
	});

	test('the Commits view draws the graph of the stack, and opens a commit to its files', async () => {
		await vscode.commands.executeCommand('betterdiff.commits.focus');
		// five commits and the commit of origin/master they are stacked on
		await until('the graph in the webview', () => api.graph.rendered?.rows === 6 && api.graph.rendered.files === 0);
		// Next Commit starts the walk at the first commit: the graph opens it and shows its file
		await vscode.commands.executeCommand('betterdiff.nextCommit');
		await diffNamed('one.ts');
		await until('the commit open in the graph', () => api.graph.rendered?.files === 1);
		await vscode.commands.executeCommand('betterdiff.nextCommit');
		await diffNamed('README.md');
		await until('the next commit open as well', () => api.graph.rendered?.files === 2);
	});

	test('a file opens as a side-by-side diff of two revisions, and Next / Previous File walk the list', async () => {
		const [, layer] = await api.views.stack.getChildren();
		await vscode.commands.executeCommand('betterdiff.openFile', await fileIn(layer, 'src/b.ts', 'stack'));
		const diff = await diffNamed('b.ts (feature-1 ↔ feature-2)');
		assert.equal((await editorOf(diff.original)).document.getText(), '// b\nexport const b = 2;\n');
		assert.match((await editorOf(diff.modified)).document.getText(), /export function alpha/);

		await vscode.commands.executeCommand('betterdiff.previousFile');
		await diffNamed('a.ts (feature-1 ↔ feature-2)');
		await vscode.commands.executeCommand('betterdiff.nextFile');
		await diffNamed('b.ts (feature-1 ↔ feature-2)');
	});

	test('moved code is marked on both sides, and the move can be followed and compared', async () => {
		const [, layer] = await api.views.stack.getChildren();
		await vscode.commands.executeCommand('betterdiff.openFile', await fileIn(layer, 'src/b.ts', 'stack'));
		const diff = await diffNamed('b.ts');
		const right = await editorOf(diff.modified);
		const side = await until('the moved block on the right', () => {
			const s = api.decorator.sideOf(right);
			return s?.annotations.length ? s : undefined;
		});
		assert.equal(side.side, 'right');
		assert.deepEqual([side.annotations[0].start, side.annotations[0].count, side.annotations[0].other.path], [4, 5, 'src/a.ts']);

		// from the block in b.ts to where it was in a.ts, on the left side
		await vscode.commands.executeCommand('betterdiff.goToMove', side.uri, side.otherUri, side.annotations[0].id);
		const source = await diffNamed('a.ts');
		const left = await editorOf(source.original);
		assert.equal(left.selection.active.line, 2, 'the cursor is on the first moved line');
		const leftSide = await until('the moved block on the left', () => {
			const s = api.decorator.sideOf(left);
			return s?.annotations.length ? s : undefined;
		});
		assert.equal(leftSide.side, 'left');

		await vscode.commands.executeCommand('betterdiff.compareMove', leftSide.uri, leftSide.otherUri, leftSide.annotations[0].id);
		const blocks = await diffNamed('Moved: a.ts:3-7 ↔ b.ts:4-8');
		assert.equal((await editorOf(blocks.original)).document.getText(), (await editorOf(blocks.modified)).document.getText());
	});

	test('Next Commit starts a walk through the commits, and goes on from one to the next', async () => {
		await vscode.commands.executeCommand('betterdiff.nextCommit');
		const first = await diffNamed('one.ts');
		assert.equal((await editorOf(first.original)).document.getText(), '', 'the file is new in this commit');
		await vscode.commands.executeCommand('betterdiff.nextCommit');
		await diffNamed('README.md');
		// Next File at a commit's last file goes on into the next commit
		await vscode.commands.executeCommand('betterdiff.nextFile');
		await diffNamed('one.ts');
		await vscode.commands.executeCommand('betterdiff.previousCommit');
		await diffNamed('README.md');
	});

	test('the working tree is the right side of the branch comparison, as the real file', async () => {
		const [base] = await api.views.branch.getChildren();
		await vscode.commands.executeCommand('betterdiff.openFile', await fileIn(base, 'src/b.ts', 'branch'));
		const diff = await diffNamed('b.ts');
		assert.match(diff.label, /↔ working tree\)$/);
		assert.equal(diff.modified.scheme, 'file');
	});
});
