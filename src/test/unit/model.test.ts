import * as assert from 'node:assert/strict';
import { gitRunner, memoized } from '../../git/exec';
import { parsePullRequests } from '../../git/github';
import {
	EMPTY_TREE, WORKING_TREE, aheadBehind, baseBranch, branchRef, changedFiles, commitComparison, commitsBetween, comparePaths, currentBranch,
	fileAt, isDirty, localStackParents, mergeBase, parseNameStatus, parseNumstat, resolve, upstreamOf,
} from '../../git/model';
import { TestRepo, lines, stackedRepo } from '../repo';

suite('git: parsing', () => {
	test('name-status with renames', () => {
		assert.deepEqual(parseNameStatus('M\0src/a.ts\0R087\0old name.ts\0new name.ts\0A\0b.ts\0D\0c.ts\0'), [
			{ status: 'M', path: 'src/a.ts' },
			{ status: 'R', oldPath: 'old name.ts', path: 'new name.ts' },
			{ status: 'A', path: 'b.ts' },
			{ status: 'D', path: 'c.ts' },
		]);
		assert.deepEqual(parseNameStatus(''), []);
	});

	test('numstat with renames and binaries', () => {
		const stats = parseNumstat('3\t1\tsrc/a.ts\x000\t0\t\0old name.ts\0new name.ts\0-\t-\timg.png\0');
		assert.deepEqual(stats.get('src/a.ts'), { added: 3, deleted: 1, binary: false });
		assert.deepEqual(stats.get('new name.ts'), { added: 0, deleted: 0, binary: false });
		assert.deepEqual(stats.get('img.png'), { binary: true });
	});

	test('paths sort folders before files at every level', () => {
		const paths = ['z.ts', 'src/b.ts', 'src/deep/x.ts', 'README.md', 'src/a.ts'];
		assert.deepEqual(paths.sort(comparePaths), ['src/deep/x.ts', 'src/a.ts', 'src/b.ts', 'README.md', 'z.ts']);
	});

	test('pull requests from gh, malformed output ignored', () => {
		const json = JSON.stringify([
			{ number: 7, title: 'Two', headRefName: 'feature-2', baseRefName: 'feature-1', url: 'https://example.test/7', isDraft: true },
			{ number: 'x', headRefName: 'bad' },
		]);
		assert.deepEqual(parsePullRequests(json), [{ number: 7, title: 'Two', head: 'feature-2', base: 'feature-1', url: 'https://example.test/7', draft: true }]);
		assert.deepEqual(parsePullRequests('not json'), []);
		assert.deepEqual(parsePullRequests('{}'), []);
	});
});

suite('git: a stacked repository', function () {
	this.timeout(60000);
	const { repo, origin } = stackedRepo();
	const g = memoized(gitRunner(repo.dir));
	suiteTeardown(() => {
		repo.dispose();
		origin.dispose();
	});

	test('the current branch, the base branch and the merge base', async () => {
		assert.equal(await currentBranch(g), 'feature-3');
		assert.equal(await baseBranch(g), 'origin/master');
		assert.equal(await baseBranch(g, 'feature-1'), 'feature-1');
		assert.equal(await baseBranch(g, 'no-such-branch'), 'origin/master', 'a configured branch that does not exist is skipped');
		assert.equal(await mergeBase(g, 'origin/master', 'HEAD'), await resolve(g, 'master'));
		assert.equal(await resolve(g, 'nope'), undefined);
	});

	test('changed files between the merge base and the branch, with counts', async () => {
		const base = (await mergeBase(g, 'origin/master', 'HEAD'))!;
		const files = await changedFiles(g, base, (await resolve(g, 'HEAD'))!);
		assert.deepEqual(files.map((f) => [f.status, f.path, f.added, f.deleted]), [
			['A', 'src/deep/nested/three.ts', 1, 0],
			['M', 'src/a.ts', 0, 5],
			['M', 'src/b.ts', 6, 0],
			['A', 'src/one.ts', 2, 0],
			['M', 'README.md', 2, 0],
		]);
	});

	test('commits of the branch, oldest first, each against its parent', async () => {
		const commits = await commitsBetween(g, 'origin/master', 'HEAD');
		assert.deepEqual(commits.map((c) => c.subject), ['one a', 'one b', 'one c', 'two a', 'three a']);
		const cmp = commitComparison(commits[3]);
		assert.equal(cmp.base, commits[2].sha);
		assert.deepEqual((await changedFiles(g, cmp.base, cmp.head)).map((f) => f.path), ['src/a.ts', 'src/b.ts']);
		const [root] = await commitsBetween(g, EMPTY_TREE, 'master');
		assert.deepEqual([root.subject, root.parents], ['base', []]);
	});

	test('the upstream, and how far ahead of it the branch is', async () => {
		assert.equal(await upstreamOf(g, 'feature-1'), 'origin/feature-1');
		assert.deepEqual(await aheadBehind(g, 'origin/feature-1', 'feature-1'), { ahead: 1, behind: 0 });
		assert.equal(await upstreamOf(g, 'feature-3'), undefined, 'never pushed');
	});

	test('a file at a commit, and one that is not there', async () => {
		assert.equal(await fileAt(g, 'master', 'src/b.ts'), lines('// b', 'export const b = 2;'));
		assert.equal(await fileAt(g, 'master', 'src\\b.ts'), lines('// b', 'export const b = 2;'));
		assert.equal(await fileAt(g, 'master', 'src/one.ts'), '');
		assert.equal(await fileAt(g, EMPTY_TREE, 'src/b.ts'), '');
	});

	test('branch names resolve locally first, then on origin', async () => {
		assert.equal(await branchRef(g, 'feature-2'), 'feature-2');
		assert.equal(await branchRef(g, 'missing'), undefined);
	});

	test('the stack from history: below and above the current branch', async () => {
		const at = async (branch: string) => Object.fromEntries(await localStackParents(gitRunner(repo.dir), branch, 'origin/master', 'master'));
		assert.deepEqual(await at('feature-3'), { 'feature-3': 'feature-2', 'feature-2': 'feature-1', 'feature-1': 'master' });
		assert.deepEqual(await at('feature-1'), { 'feature-1': 'master', 'feature-2': 'feature-1', 'feature-3': 'feature-2' });
		assert.deepEqual(await at('feature-2'), { 'feature-2': 'feature-1', 'feature-1': 'master', 'feature-3': 'feature-2' });
	});
});

suite('git: the working tree', function () {
	this.timeout(60000);
	const repo = new TestRepo();
	suiteTeardown(() => repo.dispose());

	test('uncommitted edits, deletions and untracked files count; ignored files do not', async () => {
		const base = repo.commit('base', { 'a.ts': lines('one'), 'gone.ts': lines('x'), '.gitignore': 'ignored.ts\n' });
		const g = gitRunner(repo.dir);
		assert.equal(await isDirty(g), false);
		repo.write({ 'a.ts': lines('one', 'two'), 'gone.ts': null, 'new.ts': lines('n'), 'ignored.ts': lines('i') });
		assert.equal(await isDirty(g), true);
		const files = await changedFiles(g, base, WORKING_TREE);
		assert.deepEqual(files.map((f) => [f.status, f.path]), [['M', 'a.ts'], ['D', 'gone.ts'], ['?', 'new.ts']]);
	});

	test('a root commit is compared with the empty tree', async () => {
		const g = gitRunner(repo.dir);
		const [root] = await commitsBetween(g, EMPTY_TREE, 'HEAD');
		const cmp = commitComparison(root);
		assert.equal(cmp.base, EMPTY_TREE);
		assert.deepEqual((await changedFiles(g, cmp.base, cmp.head)).map((f) => [f.status, f.path]), [['A', '.gitignore'], ['A', 'a.ts'], ['A', 'gone.ts']]);
	});
});
