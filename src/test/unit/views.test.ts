import * as assert from 'node:assert/strict';
import { gitRunner, memoized } from '../../git/exec';
import type { PullRequest } from '../../git/github';
import { WORKING_TREE } from '../../git/model';
import { annotationAt, lineSpan, movedLineCount } from '../../moves/annotate';
import { MovesService } from '../../moves/service';
import { type ComparisonNode, type FileNode, type Node, type Settings, childrenOf, firstFile, locate, nextFile, nextStep } from '../../views/nodes';
import { type RootContext, branchRoots, commitRoots, stackRoots } from '../../views/roots';
import { lines, stackedRepo } from '../repo';

const TREE: Settings = { layout: 'tree', commitsOrder: 'oldestFirst', includeWorkingTree: false };
const label = (n: Node) => (n.kind === 'commit' ? n.commit.subject : n.kind === 'folder' ? n.folder.name : n.kind === 'file' ? n.change.path : n.label);

suite('views', function () {
	this.timeout(60000);
	const { repo, origin, alpha } = stackedRepo();
	suiteTeardown(() => {
		repo.dispose();
		origin.dispose();
	});
	const context = (settings: Settings, prs?: PullRequest[]): RootContext => ({
		git: memoized(gitRunner(repo.dir)), root: repo.dir, settings, baseBranch: '', pullRequests: async () => prs,
	});
	// every file from `first` on, by Next File
	const walk = async (first: FileNode | undefined, roots: Node[], settings: Settings) => {
		const seen: string[] = [];
		for (let f = first; f; f = await nextFile(f, 1, async () => roots, settings)) {
			seen.push(f.change.path);
		}
		return seen;
	};

	test('Branch: against the merge base, and against the upstream', async () => {
		const roots = await branchRoots(context(TREE));
		assert.deepEqual(roots.map(label), ['feature-3 ↔ origin/master', 'feature-3 is not on the remote']);
		const [base] = roots as [ComparisonNode];
		const children = await childrenOf(base, TREE);
		assert.deepEqual(children.map(label), ['src', 'README.md']);
		assert.deepEqual((await childrenOf(children[0], TREE)).map(label), ['deep/nested', 'a.ts', 'b.ts', 'one.ts'].map((n) => (n.includes('.') ? `src/${n}` : n)));
		assert.deepEqual(base.files!.map((f) => f.change.path), ['src/deep/nested/three.ts', 'src/a.ts', 'src/b.ts', 'src/one.ts', 'README.md']);

		repo.git('checkout', '-q', 'feature-1');
		try {
			const [, upstream] = await branchRoots(context(TREE)) as ComparisonNode[];
			assert.equal(label(upstream), 'feature-1 ↔ origin/feature-1');
			assert.equal(upstream.description, '↑1 ↓0');
			assert.deepEqual((await childrenOf(upstream, { ...TREE, layout: 'list' })).map(label), ['src/one.ts']);
		} finally {
			repo.git('checkout', '-q', 'feature-3');
		}
	});

	test('Branch: the working tree as the right side', async () => {
		repo.write({ 'src/wip.ts': lines('// not committed') });
		try {
			const settings = { ...TREE, includeWorkingTree: true, layout: 'list' as const };
			const [base] = await branchRoots(context(settings)) as [ComparisonNode];
			assert.equal(base.cmp.head, WORKING_TREE);
			assert.ok((await childrenOf(base, settings)).some((n) => n.kind === 'file' && n.change.path === 'src/wip.ts' && n.change.status === '?'));
			const steps = await commitRoots(context(settings));
			assert.equal(label(steps.at(-1)!), 'Uncommitted changes');
		} finally {
			repo.write({ 'src/wip.ts': null });
		}
	});

	test('Commits: Next File walks every commit in turn; Next Commit jumps to the next one', async () => {
		const roots = await commitRoots(context(TREE));
		assert.deepEqual(roots.map(label), ['one a', 'one b', 'one c', 'two a', 'three a']);
		const start = (await firstFile(roots[0], 1, TREE))!;
		assert.deepEqual(await walk(start, roots, TREE), ['src/one.ts', 'README.md', 'src/one.ts', 'src/a.ts', 'src/b.ts', 'src/deep/nested/three.ts']);

		const second = (await nextStep(start, 1, async () => roots, TREE))!;
		assert.equal(second.change.path, 'README.md');
		assert.equal(await nextStep(start, -1, async () => roots, TREE), undefined);
		// from a commit's last file back to the previous commit's first
		const twoA = roots[3];
		const lastOfTwoA = (await childrenOf((await childrenOf(twoA, TREE))[0], TREE)).at(-1)!;
		assert.equal((await nextStep(lastOfTwoA, -1, async () => roots, TREE))!.owner, roots[2]);
		assert.equal((await nextFile(start, -1, async () => roots, TREE)), undefined);

		assert.deepEqual((await commitRoots(context({ ...TREE, commitsOrder: 'newestFirst' }))).map(label), ['three a', 'two a', 'one c', 'one b', 'one a']);
	});

	test('Stack: each branch against the one below, top first, from history', async () => {
		const roots = await stackRoots(context(TREE)) as ComparisonNode[];
		assert.deepEqual(roots.map((r) => `${r.label} ${r.description}`), ['feature-3 ← feature-2', 'feature-2 ← feature-1', 'feature-1 ← master']);
		const [top, middle] = roots;
		const children = await childrenOf(middle, TREE);
		assert.deepEqual(children.map(label), ['Commits', 'src']);
		assert.deepEqual((await childrenOf(children[0], TREE)).map(label), ['two a']);
		assert.deepEqual(middle.files!.map((f) => f.change.path), ['src/a.ts', 'src/b.ts']);
		// Next File stays in the layer, and doesn't wander into its commits
		assert.deepEqual(await walk(middle.files![0], roots, TREE), ['src/a.ts', 'src/b.ts']);
		assert.deepEqual(await walk(top.files?.[0] ?? (await childrenOf(top, TREE), top.files![0]), roots, TREE), ['src/deep/nested/three.ts']);
		// and within the layer's commits it walks those
		const [commit] = await childrenOf(children[0], TREE);
		const inCommit = (await childrenOf((await childrenOf(commit, TREE))[0], TREE))[0] as FileNode;
		assert.deepEqual(await walk(inCommit, roots, TREE), ['src/a.ts', 'src/b.ts']);
	});

	test('Stack: pull requests name the parents, and a rebased parent is flagged', async () => {
		const pr = (number: number, head: string, base: string): PullRequest => ({ number, title: `PR ${number}`, head, base, url: `https://example.test/${number}`, draft: number === 2 });
		// feature-1 gets a commit feature-2 doesn't have
		repo.git('checkout', '-q', 'feature-1');
		repo.commit('one d', { 'src/one.ts': lines('export const one = 1;', 'export const uno = 1;', 'export const eins = 1;') });
		repo.git('checkout', '-q', 'feature-3');
		try {
			const roots = await stackRoots(context(TREE, [pr(1, 'feature-1', 'master'), pr(2, 'feature-2', 'feature-1'), pr(3, 'feature-3', 'feature-2')])) as ComparisonNode[];
			assert.deepEqual(roots.map((r) => `${r.label} ${r.description}`), ['feature-3 ← feature-2 · #3', 'feature-2 ← feature-1 · #2 · draft · behind parent', 'feature-1 ← master · #1']);
			assert.equal(roots[0].contextValue, 'betterdiff.layer.pr');
			// still only feature-2's own change
			await childrenOf(roots[1], TREE);
			assert.deepEqual(roots[1].files!.map((f) => f.change.path), ['src/a.ts', 'src/b.ts']);
			// a pull request for a branch that isn't here
			const withMissing = await stackRoots(context(TREE, [pr(4, 'feature-4', 'feature-3')]));
			assert.equal(`${label(withMissing[0])} ${(withMissing[0] as ComparisonNode).description}`, "feature-4 ← feature-3 · feature-4 isn't fetched");
		} finally {
			repo.git('branch', '-q', '-f', 'feature-1', 'feature-1~1');
		}
	});

	test('a node is found again by its id after a refresh', async () => {
		const before = await stackRoots(context(TREE)) as ComparisonNode[];
		await childrenOf(before[1], TREE);
		const old = before[1].files![1];
		const after = await stackRoots(context(TREE));
		const found = await locate(old.id, async () => after, TREE);
		assert.ok(found && found !== old && found.kind === 'file');
		assert.equal(found.change.path, 'src/b.ts');
		assert.equal(await locate('stack/feature-2/file:nope.ts', async () => after, TREE), undefined);
		// in a commit inside a layer's group
		const [group] = await childrenOf(before[1], TREE);
		const [commit] = await childrenOf(group, TREE);
		const file = (await childrenOf((await childrenOf(commit, TREE))[0], TREE))[0];
		assert.equal((await locate(file.id, async () => after, TREE))?.id, file.id);
	});

	test('moves: what each side of a file shows', async () => {
		const [, middle] = await stackRoots(context(TREE)) as ComparisonNode[];
		const index = await new MovesService().get(gitRunner(repo.dir), middle.cmp.base, middle.cmp.head, {});
		assert.equal(index.moves.length, 1);
		const [left] = index.left.get('src/a.ts')!;
		const [right] = index.right.get('src/b.ts')!;
		assert.deepEqual([left.start, left.count, left.matchedLines, left.other], [3, 5, [3, 4, 5, 6, 7], { path: 'src/b.ts', start: 4, count: 5 }]);
		assert.deepEqual([right.start, right.count, right.matchedLines, right.other], [4, 5, [4, 5, 6, 7, 8], { path: 'src/a.ts', start: 3, count: 5 }]);
		assert.equal(annotationAt(index.right.get('src/b.ts'), 8), right);
		assert.equal(annotationAt(index.right.get('src/b.ts'), 9), undefined);
		assert.equal(movedLineCount(index, 'src/b.ts'), 5);
		assert.equal(movedLineCount(index, 'README.md'), 0);
		assert.equal(lineSpan(4, 5), '4-8');
		assert.equal(lineSpan(4, 1), '4');
	});

	test('moves: an edited line inside a moved block is not one of the dimmed lines; the working tree counts', async () => {
		const edited = [...alpha];
		edited[2] = '\tconsole.info("alpha, renamed", doubled);';
		repo.write({ 'src/b.ts': lines('// b', 'export const b = 2;'), 'src/c.ts': lines('// c', ...edited.map((l) => '\t' + l)) });
		try {
			const head = repo.git('rev-parse', 'HEAD');
			const index = await new MovesService().get(gitRunner(repo.dir), head, WORKING_TREE, {});
			const [right] = index.right.get('src/c.ts')!;
			assert.equal(right.edited, true);
			assert.deepEqual(right.matchedLines, [2, 3, 5, 6], 're-indented lines match; the edited one (4) does not');
			assert.deepEqual(index.left.get('src/b.ts')![0].matchedLines, [4, 5, 7, 8]);
		} finally {
			repo.git('checkout', '-q', '--', 'src/b.ts');
			repo.write({ 'src/c.ts': null });
		}
	});
});
