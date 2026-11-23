// Throwaway git repositories for the tests.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };

export const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();

export const lines = (...l: string[]) => l.join('\n') + '\n';

export class TestRepo {
	readonly dir: string;

	constructor(prefix = 'betterdiff-') {
		// the real path: on macOS the temp dir is a symlink, and git reports where it leads
		this.dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
		git(this.dir, 'init', '-q', '-b', 'master');
	}

	/** Writes files (null deletes one) without committing. */
	write(files: Record<string, string | null>): void {
		for (const [p, text] of Object.entries(files)) {
			const f = path.join(this.dir, p);
			if (text === null) {
				fs.rmSync(f);
			} else {
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, text);
			}
		}
	}

	/** Writes files and commits everything; returns the commit. */
	commit(message: string, files: Record<string, string | null> = {}): string {
		this.write(files);
		git(this.dir, 'add', '-A');
		git(this.dir, 'commit', '-q', '--allow-empty', '-m', message);
		return git(this.dir, 'rev-parse', 'HEAD');
	}

	git(...args: string[]): string {
		return git(this.dir, ...args);
	}

	dispose(): void {
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}

/**
 * A repository with a remote and a stack of three branches:
 *
 *   master: base ── (origin/master)
 *   feature-1: + "one a", "one b"          (pushed; then "one c" locally)
 *   feature-2: + "two a"   (moves alpha() from src/a.ts to src/b.ts)
 *   feature-3: + "three a"                 (checked out)
 */
export function stackedRepo(): { repo: TestRepo; origin: TestRepo; alpha: string[] } {
	const origin = new TestRepo('betterdiff-origin-');
	origin.git('config', 'receive.denyCurrentBranch', 'ignore');
	const repo = new TestRepo();
	const alpha = ['export function alpha(x: number) {', '\tconst doubled = x * 2;', '\tconsole.log("alpha", doubled);', '\treturn doubled;', '}'];
	repo.commit('base', { 'src/a.ts': lines('// a', 'export const a = 1;', ...alpha), 'src/b.ts': lines('// b', 'export const b = 2;'), 'README.md': lines('# test') });
	repo.git('remote', 'add', 'origin', origin.dir);
	repo.git('push', '-q', '-u', 'origin', 'master');

	repo.git('checkout', '-q', '-b', 'feature-1');
	repo.commit('one a', { 'src/one.ts': lines('export const one = 1;') });
	repo.commit('one b', { 'README.md': lines('# test', '', 'one') });
	repo.git('push', '-q', '-u', 'origin', 'feature-1');
	repo.commit('one c', { 'src/one.ts': lines('export const one = 1;', 'export const uno = 1;') });

	repo.git('checkout', '-q', '-b', 'feature-2');
	repo.commit('two a', { 'src/a.ts': lines('// a', 'export const a = 1;'), 'src/b.ts': lines('// b', 'export const b = 2;', '', ...alpha) });

	repo.git('checkout', '-q', '-b', 'feature-3');
	repo.commit('three a', { 'src/deep/nested/three.ts': lines('export const three = 3;') });
	return { repo, origin, alpha };
}
