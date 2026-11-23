import * as assert from 'node:assert/strict';
import { buildFileTree } from '../../fileTree';
import type { PullRequest } from '../../git/github';
import { buildStack, mergeLinks } from '../../stack';

const pr = (number: number, head: string, base: string): PullRequest => ({ number, title: `PR ${number}`, head, base, url: `https://example.test/${number}`, draft: false });
const brief = (layers: ReturnType<typeof buildStack>) => layers.map((l) => `${l.branch}<-${l.parent}${l.current ? '*' : ''}${l.pr ? `#${l.pr.number}` : ''}`);

suite('stack', () => {
	test('a branch nothing links sits on the trunk', () => {
		assert.deepEqual(brief(buildStack('solo', 'master', new Map())), ['solo<-master*']);
	});

	test('from the middle of a stack: below, itself, above', () => {
		const links = mergeLinks(new Map(), [pr(1, 'a', 'master'), pr(2, 'b', 'a'), pr(3, 'c', 'b'), pr(9, 'other', 'master')]);
		const layers = buildStack('b', 'master', links);
		assert.deepEqual(brief(layers), ['a<-master#1', 'b<-a*#2', 'c<-b#3']);
		assert.deepEqual(layers.map((l) => l.depth), [0, 1, 2]);
	});

	test('pull requests win over history, which fills in what has no pull request', () => {
		// after `a` was rebased, history says b sits on master; its pull request knows better
		const links = mergeLinks(new Map([['b', 'master'], ['c', 'b']]), [pr(1, 'a', 'master'), pr(2, 'b', 'a')]);
		assert.deepEqual(brief(buildStack('c', 'master', links)), ['a<-master#1', 'b<-a#2', 'c<-b*']);
		assert.equal(links.get('c')!.source, 'git');
		assert.equal(links.get('b')!.source, 'pr');
	});

	test('a stack that forks above the current branch lists each side', () => {
		const links = mergeLinks(new Map(), [pr(1, 'a', 'master'), pr(2, 'b', 'a'), pr(3, 'c', 'a'), pr(4, 'd', 'c')]);
		assert.deepEqual(brief(buildStack('a', 'master', links)), ['a<-master*#1', 'b<-a#2', 'c<-a#3', 'd<-c#4']);
	});

	test('a base that is neither the trunk nor a known branch ends the stack; a cycle does too', () => {
		assert.deepEqual(brief(buildStack('b', 'master', mergeLinks(new Map(), [pr(1, 'a', 'release'), pr(2, 'b', 'a')]))), ['a<-release#1', 'b<-a*#2']);
		assert.deepEqual(brief(buildStack('a', 'master', mergeLinks(new Map(), [pr(1, 'a', 'b'), pr(2, 'b', 'a')]))), ['b<-a#2', 'a<-b*#1']);
	});
});

suite('file tree', () => {
	test('folders with one subfolder and no files are compacted', () => {
		const tree = buildFileTree(['src/deep/nested/three.ts', 'src/a.ts', 'src/b.ts', 'docs/guide/intro.md', 'README.md'], (p) => p);
		assert.deepEqual(tree.files, ['README.md']);
		assert.deepEqual(tree.folders.map((f) => [f.name, f.path]), [['src', 'src'], ['docs/guide', 'docs/guide']]);
		const [src] = tree.folders;
		assert.deepEqual(src.files, ['src/a.ts', 'src/b.ts']);
		assert.deepEqual(src.folders.map((f) => [f.name, f.path, f.files]), [['deep/nested', 'src/deep/nested', ['src/deep/nested/three.ts']]]);
	});

	test('no files, no folders', () => {
		assert.deepEqual(buildFileTree([], (p: string) => p), { name: '', path: '', folders: [], files: [] });
	});
});
