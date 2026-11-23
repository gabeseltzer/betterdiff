import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectMoves, type DetectedMove } from '../../moves/detect';
import { gitRunner } from '../../git/exec';
import { diffCommits, diffWorkingTree, parseDiff, resolveCommit, showFile, splitLines, unquotePath } from '../../git/hunks';

// A throwaway repository with two commits: `a` and `b` map paths to contents (null deletes).
interface Repo { dir: string; a: string; b: string }
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
const repos: string[] = [];

function makeRepo(a: Record<string, string>, b: Record<string, string | null>): Repo {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cme-moves-'));
	repos.push(dir);
	git(dir, 'init', '-q', '-b', 'main');
	const write = (files: Record<string, string | null>) => {
		for (const [p, text] of Object.entries(files)) {
			const f = path.join(dir, p);
			if (text === null) {
				fs.rmSync(f);
			} else {
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, text);
			}
		}
		git(dir, 'add', '-A');
		git(dir, 'commit', '-q', '--allow-empty', '-m', 'x');
		return git(dir, 'rev-parse', 'HEAD');
	};
	return { dir, a: write(a), b: write(b) };
}
const movesIn = async (r: Repo, options = {}) => detectMoves(await diffCommits(gitRunner(r.dir), r.a, r.b), options);
const brief = (m: DetectedMove) => `${m.source.path}:${m.source.start}+${m.source.lines.length} -> ${m.dest.path}:${m.dest.start}+${m.dest.lines.length}${m.edited ? ' (edited)' : ''}`;
const lines = (...l: string[]) => l.join('\n') + '\n';

const ALPHA = ['function alpha(x: number) {', '\tconst doubled = x * 2;', '\tconsole.log("alpha", doubled);', '\treturn doubled;', '}'];
const BETA = ['export function beta(name: string) {', '\tconst greeting = `hello ${name}`;', '\treturn greeting.toUpperCase();', '}'];
const FILLER = (tag: string) => [`// ${tag} keeps some lines of its own`, `export const ${tag}Version = 1;`];

suite('moves: parsing git diff', () => {
	test('hunks with omitted counts, insertions, deletions and no-newline markers', () => {
		const files = parseDiff([
			'diff --git a/src/x.ts b/src/x.ts',
			'index 1..2 100644',
			'--- a/src/x.ts',
			'+++ b/src/x.ts',
			'@@ -3 +3 @@ header',
			'-old line',
			'+new line',
			'@@ -10,2 +9,0 @@',
			'-gone 1',
			'-gone 2',
			'@@ -20,0 +18,2 @@',
			'+added 1',
			'+--- looks like a header but is content',
			'\\ No newline at end of file',
		].join('\n'));
		assert.deepEqual(files, [{
			oldPath: 'src/x.ts', newPath: 'src/x.ts', binary: false, hunks: [
				{ oldStart: 3, deleted: ['old line'], newStart: 3, added: ['new line'] },
				{ oldStart: 10, deleted: ['gone 1', 'gone 2'], newStart: 9, added: [] },
				{ oldStart: 20, deleted: [], newStart: 18, added: ['added 1', '--- looks like a header but is content'] },
			],
		}]);
	});

	test('new, deleted, renamed and binary files', () => {
		const files = parseDiff([
			'diff --git a/n.ts b/n.ts', 'new file mode 100644', 'index 0..1', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1 @@', '+x',
			'diff --git a/d.ts b/d.ts', 'deleted file mode 100644', 'index 1..0', '--- a/d.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-y',
			'diff --git a/old name.ts b/new name.ts', 'similarity index 100%', 'rename from old name.ts', 'rename to new name.ts',
			'diff --git a/i.png b/i.png', 'index 1..2 100644', 'Binary files a/i.png and b/i.png differ',
		].join('\n'));
		assert.deepEqual(files.map((f) => [f.oldPath, f.newPath, f.binary, f.hunks.length]), [
			[undefined, 'n.ts', false, 1],
			['d.ts', undefined, false, 1],
			['old name.ts', 'new name.ts', false, 0],
			['i.png', 'i.png', true, 0],
		]);
	});

	test('quoted paths, CRLF content', () => {
		assert.equal(unquotePath('"a/tab\\there \\"q\\" \\303\\251.ts"'), 'a/tab\there "q" é.ts');
		assert.equal(unquotePath('plain.ts'), 'plain.ts');
		const [f] = parseDiff('diff --git "a/x\\ty.ts" "b/x\\ty.ts"\r\n--- "a/x\\ty.ts"\r\n+++ "b/x\\ty.ts"\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n');
		assert.deepEqual([f.oldPath, f.newPath, f.hunks[0].deleted, f.hunks[0].added], ['x\ty.ts', 'x\ty.ts', ['a'], ['b']]);
	});

	test('splitLines drops line ends and the empty line after a final newline', () => {
		assert.deepEqual(splitLines('a\r\nb\nc\n'), ['a', 'b', 'c']);
		assert.deepEqual(splitLines(''), []);
		assert.deepEqual(splitLines('\n'), ['']);
	});
});

suite('moves: detection in real repositories', function () {
	this.timeout(30000);
	suiteTeardown(() => {
		for (const dir of repos) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a function moved to an existing file', async () => {
		const r = makeRepo(
			{ 'src/a.ts': lines(...FILLER('a'), ...ALPHA), 'src/b.ts': lines(...FILLER('b')) },
			{ 'src/a.ts': lines(...FILLER('a')), 'src/b.ts': lines(...FILLER('b'), '', ...ALPHA) },
		);
		const moves = await movesIn(r);
		assert.deepEqual(moves.map(brief), ['src/a.ts:3+5 -> src/b.ts:4+5']);
		assert.deepEqual(moves[0].dest.lines, ALPHA);
		assert.equal(moves[0].matched, 5);
	});

	test('a move with edits on the way, and a re-indent', async () => {
		const edited = [...ALPHA];
		edited[2] = '\tconsole.info("alpha moved", doubled);';
		const r = makeRepo(
			{ 'a.ts': lines(...FILLER('a'), ...ALPHA), 'b.ts': lines(...FILLER('b')) },
			{ 'a.ts': lines(...FILLER('a')), 'b.ts': lines(...FILLER('b'), 'class K {', ...edited.map((l) => '  ' + l), '}') },
		);
		const moves = await movesIn(r);
		assert.deepEqual(moves.map(brief), ['a.ts:3+5 -> b.ts:4+5 (edited)']);
		assert.equal(moves[0].matched, 4);
	});

	test('two sources into one destination, which is new at B', async () => {
		const r = makeRepo(
			{ 'a.ts': lines(...FILLER('a'), ...ALPHA), 'b.ts': lines(...BETA, ...FILLER('b')) },
			{ 'a.ts': lines(...FILLER('a')), 'b.ts': lines(...FILLER('b')), 'lib/both.ts': lines('// both', ...ALPHA, '', ...BETA) },
		);
		assert.deepEqual((await movesIn(r)).map(brief), ['a.ts:3+5 -> lib/both.ts:2+5', 'b.ts:1+4 -> lib/both.ts:8+4']);
	});

	test('one source split over two destinations', async () => {
		const r = makeRepo(
			{ 'all.ts': lines(...ALPHA, ...BETA, ...FILLER('all')) },
			{ 'all.ts': lines(...FILLER('all')), 'x.ts': lines(...ALPHA), 'y.ts': lines(...BETA) },
		);
		assert.deepEqual((await movesIn(r)).map(brief), ['all.ts:1+5 -> x.ts:1+5', 'all.ts:6+4 -> y.ts:1+4']);
	});

	test('a renamed file is not a move; code moved out of it is', async () => {
		const body = [...FILLER('r'), 'export function keep() {', '\treturn "this file is renamed";', '}'];
		const r = makeRepo(
			{ 'old.ts': lines(...body, ...ALPHA), 'other.ts': lines(...FILLER('o')) },
			{ 'old.ts': null, 'new.ts': lines(...body), 'other.ts': lines(...FILLER('o'), ...ALPHA) },
		);
		assert.deepEqual((await movesIn(r)).map(brief), ['old.ts:6+5 -> other.ts:3+5']);
	});

	test('moves within one file are left to VS Code', async () => {
		const r = makeRepo({ 'a.ts': lines(...ALPHA, ...FILLER('a'), ...BETA) }, { 'a.ts': lines(...BETA, ...FILLER('a'), ...ALPHA) });
		assert.deepEqual(await movesIn(r), []);
	});

	test('with sameFile, a move within one file is reported; an in-place re-indent is not', async () => {
		const reindented = ALPHA.map((l) => '  ' + l);
		const r = makeRepo(
			{ 'a.ts': lines(...ALPHA, ...FILLER('a'), ...BETA), 'b.ts': lines(...FILLER('b'), ...ALPHA) },
			{ 'a.ts': lines(...BETA, ...FILLER('a'), ...ALPHA), 'b.ts': lines(...FILLER('b'), ...reindented) },
		);
		const moves = await movesIn(r, { sameFile: true });
		assert.ok(moves.every((m) => m.sameFile), moves.map(brief).join(', '));
		assert.ok(moves.some((m) => m.source.path === 'a.ts' && m.dest.path === 'a.ts'), moves.map(brief).join(', '));
		assert.ok(!moves.some((m) => m.dest.path === 'b.ts'), 're-indenting b.ts in place is not a move');
		assert.deepEqual(await movesIn(r), [], 'and without sameFile, nothing');
	});

	test('CRLF files', async () => {
		const crlf = (...l: string[]) => l.join('\r\n') + '\r\n';
		const r = makeRepo(
			{ 'a.ts': crlf(...FILLER('a'), ...ALPHA), 'b.ts': crlf(...FILLER('b')) },
			{ 'a.ts': crlf(...FILLER('a')), 'b.ts': crlf(...FILLER('b'), ...ALPHA) },
		);
		const moves = await movesIn(r);
		assert.deepEqual(moves.map(brief), ['a.ts:3+5 -> b.ts:3+5']);
		assert.deepEqual(moves[0].dest.lines, ALPHA, 'no \\r left in the lines');
	});

	test('blocks of trivial lines, or too short, are not moves', async () => {
		const trivial = ['}', '', '\t}', ')', '];'];
		const r = makeRepo(
			{ 'a.ts': lines(...FILLER('a'), ...trivial, 'const shortOne = 1;'), 'b.ts': lines(...FILLER('b')) },
			{ 'a.ts': lines(...FILLER('a')), 'b.ts': lines(...FILLER('b'), ...trivial, 'const shortOne = 1;') },
		);
		assert.deepEqual(await movesIn(r), []);
		assert.equal((await movesIn(r, { minLines: 1, minAlnum: 5 })).length, 1, 'with lower thresholds the one real line counts');
	});

	test('diffWorkingTree: changes on disk against a commit, untracked files as added, ignored ones not', async () => {
		const r = makeRepo({ 'a.ts': lines(...FILLER('a'), ...ALPHA), '.gitignore': 'ignored.ts\n' }, {});
		fs.writeFileSync(path.join(r.dir, 'a.ts'), lines(...FILLER('a')));
		fs.writeFileSync(path.join(r.dir, 'new.ts'), lines('// new', ...ALPHA));
		fs.writeFileSync(path.join(r.dir, 'ignored.ts'), lines(...ALPHA));
		const files = await diffWorkingTree(gitRunner(r.dir), (p) => fs.promises.readFile(path.join(r.dir, p), 'utf8'), r.b);
		assert.deepEqual(files.map((f) => [f.oldPath, f.newPath]).sort(), [[undefined, 'new.ts'], ['a.ts', 'a.ts']]);
		assert.deepEqual(detectMoves(files).map(brief), ['a.ts:3+5 -> new.ts:2+5']);
	});


	test('showFile and resolveCommit read a commit', async () => {
		const r = makeRepo({ 'd/a.ts': lines('one', 'two') }, { 'd/a.ts': lines('one', 'two', 'three') });
		const g = gitRunner(r.dir);
		assert.deepEqual(await showFile(g, r.a, 'd\\a.ts'), ['one', 'two']);
		assert.equal(await resolveCommit(g, `${r.b}~1`), r.a);
		await assert.rejects(resolveCommit(g, 'no-such-ref'));
	});

	// git's own move detection as an oracle: every line git colors as moved between files is in one of our moves.
	test('agrees with git diff --color-moved on cross-file moves', async () => {
		const r = makeRepo(
			{ 'a.ts': lines(...FILLER('a'), ...ALPHA, ...BETA), 'b.ts': lines(...FILLER('b')), 'c.ts': lines('// c', ...FILLER('c')) },
			{ 'a.ts': lines(...FILLER('a')), 'b.ts': lines(...FILLER('b'), ...BETA), 'c.ts': lines('// c', ...ALPHA, ...FILLER('c')) },
		);
		const out = git(r.dir, '-c', 'color.diff.newMoved=blue', '-c', 'color.diff.newMovedAlternative=blue', '--no-pager', 'diff', '--color=always', '--color-moved=plain', '--unified=0', r.a, r.b);
		const gitMoved: string[] = [];
		let file = '';
		for (const l of out.split('\n')) {
			const plain = l.replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
			if (plain.startsWith('+++ b/')) {
				file = plain.slice(6);
			} else if (l.startsWith('\x1b[34m') && plain.startsWith('+')) {
				gitMoved.push(`${file}: ${normalizeForOracle(plain.slice(1))}`);
			}
		}
		assert.ok(gitMoved.length >= ALPHA.length + BETA.length, out);
		const ours = new Set((await movesIn(r)).flatMap((m) => m.dest.lines.map((l) => `${m.dest.path}: ${normalizeForOracle(l)}`)));
		assert.deepEqual(gitMoved.filter((l) => !ours.has(l)), []);
	});
});

const normalizeForOracle = (l: string) => l.trim();
