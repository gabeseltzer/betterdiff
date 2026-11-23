// What the views ask git: branches, merge bases, changed files, commits. No vscode import.
import { type Git, tryRun } from './exec';

/** As a comparison's head: the files on disk instead of a commit. */
export const WORKING_TREE = ':working-tree:';
/** git's empty tree: what a root commit is compared with. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type Status = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface FileChange {
	status: Status;
	/** the path at the head, relative to the repository root (at the base, for a deleted file) */
	path: string;
	/** the path at the base, when renamed or copied */
	oldPath?: string;
	added?: number;
	deleted?: number;
	binary?: boolean;
}

export interface Commit {
	sha: string;
	short: string;
	author: string;
	/** ISO 8601 */
	date: string;
	subject: string;
	parents: string[];
}

/** Two points to diff: `base` is a commit (or EMPTY_TREE), `head` a commit or WORKING_TREE. */
export interface Comparison {
	base: string;
	head: string;
	/** what the diff editor's title calls the two sides */
	baseLabel: string;
	headLabel: string;
}

export const short = (sha: string) => sha.slice(0, 7);

/** The commit a revision names, or undefined. */
export async function resolve(git: Git, rev: string): Promise<string | undefined> {
	return (await tryRun(git, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]))?.trim() || undefined;
}

/** The checked-out branch; undefined on a detached HEAD. */
export async function currentBranch(git: Git): Promise<string | undefined> {
	return (await tryRun(git, ['symbolic-ref', '--short', '--quiet', 'HEAD']))?.trim() || undefined;
}

/**
 * The branch to compare with: `configured` if it names a commit, else the remote's default
 * branch, else the first of origin/master, origin/main, master, main that exists.
 */
export async function baseBranch(git: Git, configured?: string): Promise<string | undefined> {
	const candidates: string[] = [];
	if (configured?.trim()) {
		candidates.push(configured.trim());
	}
	const originHead = (await tryRun(git, ['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD']))?.trim();
	if (originHead) {
		candidates.push(originHead);
	}
	candidates.push('origin/master', 'origin/main', 'master', 'main');
	for (const c of candidates) {
		if (await resolve(git, c)) {
			return c;
		}
	}
	return undefined;
}

export async function mergeBase(git: Git, a: string, b: string): Promise<string | undefined> {
	return (await tryRun(git, ['merge-base', a, b]))?.trim() || undefined;
}

/**
 * The branch `branch` pushes to and pulls from: its configured upstream, else the branch of the
 * same name on origin.
 */
export async function upstreamOf(git: Git, branch: string): Promise<string | undefined> {
	const configured = (await tryRun(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]))?.trim();
	if (configured && await resolve(git, configured)) {
		return configured;
	}
	const sameName = `origin/${branch}`;
	return await resolve(git, `refs/remotes/${sameName}`) ? sameName : undefined;
}

/** Commits only `local` has (ahead) and only `remote` has (behind). */
export async function aheadBehind(git: Git, remote: string, local: string): Promise<{ ahead: number; behind: number }> {
	const out = await tryRun(git, ['rev-list', '--left-right', '--count', `${remote}...${local}`]);
	const [behind, ahead] = (out ?? '0\t0').trim().split(/\s+/).map(Number);
	return { ahead: ahead || 0, behind: behind || 0 };
}

const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules', '--find-renames', '-z'];

/** `git diff --name-status -z`: `M\0path\0`, and `R100\0old\0new\0` for renames and copies. */
export function parseNameStatus(out: string): FileChange[] {
	const tokens = out.split('\0');
	const changes: FileChange[] = [];
	for (let i = 0; i < tokens.length - 1;) {
		const status = tokens[i++][0] as Status;
		if (status === 'R' || status === 'C') {
			const oldPath = tokens[i++];
			changes.push({ status, oldPath, path: tokens[i++] });
		} else {
			changes.push({ status, path: tokens[i++] });
		}
	}
	return changes;
}

/** `git diff --numstat -z`: `3\t1\tpath\0`, `3\t1\t\0old\0new\0` for renames, `-\t-\t` for binaries. */
export function parseNumstat(out: string): Map<string, { added?: number; deleted?: number; binary: boolean }> {
	const stats = new Map<string, { added?: number; deleted?: number; binary: boolean }>();
	const tokens = out.split('\0');
	for (let i = 0; i < tokens.length - 1;) {
		const [added, deleted, ...rest] = tokens[i++].split('\t');
		let path = rest.join('\t');
		if (path === '') {
			i++; // the old path
			path = tokens[i++];
		}
		const binary = added === '-';
		stats.set(path, binary ? { binary } : { added: Number(added), deleted: Number(deleted), binary });
	}
	return stats;
}

/** The files that differ between the two sides of a comparison, by path. */
export async function changedFiles(git: Git, base: string, head: string): Promise<FileChange[]> {
	const range = head === WORKING_TREE ? [base] : [base, head];
	const [names, nums, untracked] = await Promise.all([
		git.run([...DIFF, '--name-status', ...range, '--']),
		git.run([...DIFF, '--numstat', ...range, '--']),
		head === WORKING_TREE ? git.run(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']) : '',
	]);
	const stats = parseNumstat(nums);
	const changes: FileChange[] = parseNameStatus(names).map((c) => ({ ...c, ...stats.get(c.path) }));
	for (const path of untracked.split('\0').filter(Boolean)) {
		changes.push({ status: '?', path });
	}
	return changes.sort((x, y) => comparePaths(x.path, y.path));
}

/** Folders before files at every level, like the Explorer. */
export function comparePaths(a: string, b: string): number {
	const x = a.split('/');
	const y = b.split('/');
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		if (x[i] !== y[i]) {
			const xDir = i < x.length - 1;
			const yDir = i < y.length - 1;
			return xDir !== yDir ? (xDir ? -1 : 1) : x[i].localeCompare(y[i]);
		}
	}
	return x.length - y.length;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** The commits in `base..head`, oldest first. */
export async function commitsBetween(git: Git, base: string, head: string): Promise<Commit[]> {
	const out = await git.run(['log', '--reverse', '--topo-order', `--format=%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%P${RECORD}`, `${base}..${head}`, '--']);
	return out.split(RECORD).map((r) => r.trim()).filter(Boolean).map((r) => {
		const [sha, shortSha, author, date, subject, parents] = r.split(FIELD);
		return { sha, short: shortSha, author, date, subject, parents: parents ? parents.split(' ') : [] };
	});
}

/** What one commit changed: itself against its first parent (the empty tree for a root commit). */
export function commitComparison(c: Commit): Comparison {
	const parent = c.parents[0];
	return { base: parent ?? EMPTY_TREE, head: c.sha, baseLabel: parent ? short(parent) : 'empty', headLabel: c.short };
}

/** A file's text at a commit; empty when it doesn't exist there. `path` is relative to the root. */
export async function fileAt(git: Git, rev: string, path: string): Promise<string> {
	return await tryRun(git, ['show', `${rev}:${path.replace(/\\/g, '/')}`]) ?? '';
}

/** The working tree differs from HEAD, or has untracked files. */
export async function isDirty(git: Git): Promise<boolean> {
	return ((await tryRun(git, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules'])) ?? '').trim() !== '';
}

export interface Branch {
	name: string;
	sha: string;
}

/** Local branches, filtered by `for-each-ref` options such as `--merged <rev>`. */
export async function localBranches(git: Git, ...filters: string[]): Promise<Branch[]> {
	const out = await tryRun(git, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', ...filters, 'refs/heads']) ?? '';
	return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
		const [name, sha] = l.split('\t');
		return { name, sha };
	});
}

/** The local branch `name`, else the same branch on origin; undefined when neither exists. */
export async function branchRef(git: Git, name: string): Promise<string | undefined> {
	for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`, name]) {
		if (await resolve(git, ref)) {
			return ref.replace(/^refs\/(heads|remotes)\//, '');
		}
	}
	return undefined;
}

/**
 * Which local branch each branch around `current` is stacked on, from history alone: a branch's
 * parent is the nearest other branch whose tip it contains. Only branches not yet merged into
 * `trunkRef` count, and only those below `current` or above it. Branches at the same commit as
 * another are left out (there is nothing between them to show).
 */
export async function localStackParents(git: Git, current: string, trunkRef: string, trunkName: string): Promise<Map<string, string>> {
	const parents = new Map<string, string>();
	const head = await resolve(git, `refs/heads/${current}`);
	if (!head) {
		return parents;
	}
	const unmerged = ['--no-merged', trunkRef];
	const depth = new Map<string, number>();
	const depthOf = async (b: Branch) => {
		if (!depth.has(b.name)) {
			depth.set(b.name, Number((await tryRun(git, ['rev-list', '--count', `${trunkRef}..${b.sha}`]))?.trim() ?? 0));
		}
		return depth.get(b.name)!;
	};
	// the nearest of `candidates` below `b`: the one with the most commits of its own
	const nearest = async (b: Branch, candidates: Branch[]) => {
		let best: Branch | undefined;
		for (const c of candidates) {
			if (c.name !== b.name && c.sha !== b.sha && (!best || await depthOf(c) > await depthOf(best))) {
				best = c;
			}
		}
		return best;
	};

	const me: Branch = { name: current, sha: head };
	const below = (await localBranches(git, '--merged', head, ...unmerged)).filter((b) => b.sha !== head);
	// the chain down from the current branch
	for (let b: Branch | undefined = me; b;) {
		const within: Branch[] = b === me ? below : (await localBranches(git, '--merged', b.sha, ...unmerged)).filter((x) => below.some((y) => y.name === x.name));
		const parent: Branch | undefined = await nearest(b, within);
		parents.set(b.name, parent?.name ?? trunkName);
		b = parent;
	}
	// everything stacked on top of it
	const above = (await localBranches(git, '--contains', head, ...unmerged)).filter((b) => b.sha !== head);
	const seenSha = new Set<string>();
	for (const b of above) {
		if (seenSha.has(b.sha)) {
			continue; // a second name for the same commit
		}
		seenSha.add(b.sha);
		const within = (await localBranches(git, '--merged', b.sha, ...unmerged)).filter((x) => x.name === current || above.some((y) => y.name === x.name));
		const parent = await nearest(b, within.map((x) => (x.name === current ? me : x)));
		parents.set(b.name, parent?.name ?? current);
	}
	return parents;
}
