import * as assert from 'node:assert/strict';
import { gitRunner, memoized } from '../../git/exec';
import type { PullRequest } from '../../git/github';
import { WORKING_TREE, checkoutBranch, currentBranch } from '../../git/model';
import { annotationAt, lineSpan, movedLineCount } from '../../moves/annotate';
import { MovesService } from '../../moves/service';
import { type ComparisonNode, type FileNode, type Node, type Settings, childrenOf, firstFile, locate, nextFile, nextStep } from '../../views/nodes';
import { type RowModel, graphRows } from '../../views/graph';
import { type RootContext, branchRoots, commitGraph, commitRoots, stackRoots } from '../../views/roots';
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

	test('Commits: the graph of the whole stack, down to where it forks from the base branch', async () => {
		const line = (r: RowModel) => [r.subject, ...r.badges.map((b) => `[${b.label}${b.current ? '*' : ''}]`)].join(' ');
		const rows = graphRows(await commitGraph(context(TREE)));
		assert.deepEqual(rows.map(line), ['three a [feature-3*]', 'two a [feature-2]', 'one c [feature-1]', 'one b', 'one a', 'base [origin/master]']);
		assert.deepEqual(rows.map((r) => r.kind), ['commit', 'commit', 'commit', 'commit', 'commit', 'boundary']);
		// one lane, a color per branch of the stack
		assert.deepEqual(rows.map((r) => [r.lanes.circle, r.lanes.columns, r.lanes.color]), [[0, 1, 'ref'], [0, 1, 0], [0, 1, 1], [0, 1, 1], [0, 1, 1], [0, 1, 'base']]);
		assert.deepEqual(rows.map((r) => r.head), [true, false, false, false, false, false]);
		assert.deepEqual(rows[1].badges[0].branch, 'feature-2');

		// from the bottom of the stack, with a second branch on top of it and something uncommitted
		repo.git('checkout', '-q', '-b', 'side', 'feature-1');
		repo.commit('side a', { 'src/side.ts': lines('export const side = 1;') });
		repo.git('checkout', '-q', 'feature-1');
		repo.write({ 'src/wip.ts': lines('// not committed') });
		try {
			const ctx = context({ ...TREE, includeWorkingTree: true });
			const forked = graphRows(await commitGraph(ctx));
			assert.deepEqual(forked.map(line).sort(), ['Uncommitted changes', 'base [origin/master]', 'one a', 'one b', 'one c [feature-1*]', 'side a [side]', 'three a [feature-3]', 'two a [feature-2]']);
			// every branch on top is drawn, in two lanes that meet at the branch they are stacked on
			assert.equal(Math.max(...forked.map((r) => r.lanes.columns)), 3);
			const at = forked.findIndex((r) => r.head);
			assert.equal(forked[at].subject, 'one c');
			assert.equal(forked[at].lanes.segments.filter((s) => s.kind === 'in').length, 3);
			// what's uncommitted sits right above the commit it is on, and is the step after it
			assert.equal(forked[at - 1].kind, 'uncommitted');
			const steps = (await commitRoots(ctx)).map(label);
			assert.equal(steps[steps.indexOf('one c') + 1], 'Uncommitted changes');
			assert.deepEqual(steps.slice(0, 3), ['one a', 'one b', 'one c']);
		} finally {
			repo.write({ 'src/wip.ts': null });
			repo.git('checkout', '-q', 'feature-3');
			repo.git('branch', '-q', '-D', 'side');
		}
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
			// the context menu: Checkout Branch on every layer but the one we're on
			assert.deepEqual(roots.map((r) => r.contextValue), ['betterdiff.layer.current.pr', 'betterdiff.layer.pr', 'betterdiff.layer.pr']);
			assert.deepEqual(roots.map((r) => r.branch), ['feature-3', 'feature-2', 'feature-1']);
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

	test('Stack: a layer checks out its branch, and the stack stays the same', async () => {
		const [, middle] = await stackRoots(context(TREE)) as ComparisonNode[];
		assert.equal(middle.contextValue, 'betterdiff.layer');
		await checkoutBranch(gitRunner(repo.dir), middle.branch!);
		try {
			assert.equal(await currentBranch(gitRunner(repo.dir)), 'feature-2');
			const roots = await stackRoots(context(TREE)) as ComparisonNode[];
			assert.deepEqual(roots.map((r) => `${r.label} ${r.contextValue}`), ['feature-3 betterdiff.layer', 'feature-2 betterdiff.layer.current', 'feature-1 betterdiff.layer']);
			await assert.rejects(checkoutBranch(gitRunner(repo.dir), 'no-such-branch'), /no-such-branch/);
		} finally {
			repo.git('checkout', '-q', 'feature-3');
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
