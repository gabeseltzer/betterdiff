// Running git. No vscode import, so the unit tests use it against throwaway repositories.
import { execFile } from 'node:child_process';

export interface Git {
	/** The repository root the commands run in. */
	readonly cwd: string;
	/** stdout of `git <args>`; rejects when git exits with an error. */
	run(args: readonly string[]): Promise<string>;
}

/** Runs `gitPath` in `cwd`. */
export function gitRunner(cwd: string, gitPath = 'git'): Git {
	// Without optional locks, a diff against the working tree doesn't rewrite .git/index,
	// which our own watcher would take for a change.
	const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
	return {
		cwd,
		run: (args) => new Promise((resolve, reject) => {
			execFile(gitPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
				if (error) {
					reject(new Error(`git ${args.join(' ')}: ${stderr.trim() || error.message}`));
				} else {
					resolve(stdout);
				}
			});
		}),
	};
}

/** A Git that answers a repeated command from memory: one per refresh of the views. */
export function memoized(git: Git): Git {
	const cache = new Map<string, Promise<string>>();
	return {
		cwd: git.cwd,
		run: (args) => {
			const key = args.join('\0');
			let hit = cache.get(key);
			if (!hit) {
				hit = git.run(args);
				cache.set(key, hit);
			}
			return hit;
		},
	};
}

/** stdout, or undefined when git exits with an error (a ref that doesn't exist, say). */
export async function tryRun(git: Git, args: readonly string[]): Promise<string | undefined> {
	try {
		return await git.run(args);
	} catch {
		return undefined;
	}
}
