// The hunks between two commits (or a commit and the working tree), as runs of deleted and
// added lines, and a file's text at a commit. No vscode import, so the unit tests run it
// against throwaway repositories. (From context-menu-editor's src/moves/git.ts.)
import type { Git } from './exec';

export interface Hunk {
	/** first deleted line, 1-based in the old file (meaningless when nothing was deleted) */
	oldStart: number;
	deleted: string[];
	/** first added line, 1-based in the new file (meaningless when nothing was added) */
	newStart: number;
	added: string[];
}

export interface FileDiff {
	/** the path at A, relative to the repository root; undefined for a file added at B */
	oldPath?: string;
	/** the path at B; undefined for a file deleted at B */
	newPath?: string;
	binary: boolean;
	hunks: Hunk[];
}

// The user's git config must not change the output we parse: prefixes, external diff tools,
// colors, quoting of non-ASCII paths.
const DIFF_ARGS = [
	'-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules',
	'--src-prefix=a/', '--dst-prefix=b/', '--find-renames', '--unified=0',
];

/** The hunks between two commits. Renames count as the same file (`--find-renames`). */
export async function diffCommits(git: Git, a: string, b: string): Promise<FileDiff[]> {
	return parseDiff(await git.run([...DIFF_ARGS, a, b, '--']));
}

/** A file's lines at a commit; `path` is relative to the repository root. */
export async function showFile(git: Git, rev: string, path: string): Promise<string[]> {
	return splitLines(await git.run(['show', `${rev}:${path.replace(/\\/g, '/')}`]));
}

/** The commit a revision names, or an error saying it doesn't name one. */
export async function resolveCommit(git: Git, rev: string): Promise<string> {
	return (await git.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
}

/** Lines without their end-of-line characters; a final newline doesn't start another line. */
export function splitLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}

// Git quotes a path that has control characters, a quote or a backslash in it (and, with
// core.quotePath, non-ASCII): "..." with C escapes, octal for raw bytes.
export function unquotePath(s: string): string {
	if (!s.startsWith('"') || !s.endsWith('"')) {
		return s;
	}
	const bytes: number[] = [];
	const ESC: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
	const body = s.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c !== '\\') {
			bytes.push(...Buffer.from(c, 'utf8'));
			continue;
		}
		const next = body[++i];
		if (/[0-7]/.test(next)) {
			bytes.push(parseInt(body.slice(i, i + 3), 8));
			i += 2;
		} else {
			bytes.push(ESC[next] ?? next.charCodeAt(0));
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

// `--- a/x`, `+++ b/x` or /dev/null; the path may be quoted.
function headerPath(rest: string, prefix: string): string | undefined {
	const p = unquotePath(rest.replace(/\t$/, ''));
	if (p === '/dev/null') {
		return undefined;
	}
	return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

// `diff --git a/x b/y`: only needed when no ---/+++ lines follow (renames without changes,
// binary files). Unquoted paths with spaces are ambiguous; then both halves are the same path.
function gitHeaderPaths(rest: string): [string, string] | undefined {
	const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
	if (quoted && (quoted[1].startsWith('"') || quoted[2].startsWith('"'))) {
		return [unquotePath(quoted[1]).slice(2), unquotePath(quoted[2]).slice(2)];
	}
	const half = (rest.length - 1) / 2;
	if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) {
		const p = rest.slice(2, half);
		return [p, p];
	}
	return quoted ? [quoted[1].slice(2), quoted[2].slice(2)] : undefined;
}

/** Parses `git diff --unified=0` output (with the prefixes DIFF_ARGS sets). */
export function parseDiff(text: string): FileDiff[] {
	type Parsed = FileDiff & { added?: boolean; deletedFile?: boolean };
	const files: Parsed[] = [];
	let file: Parsed | undefined;
	let hunk: Hunk | undefined;
	for (const raw of text.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line.startsWith('diff --git ')) {
			const paths = gitHeaderPaths(line.slice('diff --git '.length));
			file = { oldPath: paths?.[0], newPath: paths?.[1], binary: false, hunks: [] };
			files.push(file);
			hunk = undefined;
			continue;
		}
		if (!file) {
			continue;
		}
		if (hunk && (line.startsWith('-') || line.startsWith('+'))) {
			// a hunk's own lines: content keeps everything after the marker, \r included
			const content = raw.slice(1).replace(/\r$/, '');
			(line[0] === '-' ? hunk.deleted : hunk.added).push(content);
			continue;
		}
		if (line.startsWith('@@ ')) {
			const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (m) {
				hunk = { oldStart: Number(m[1]), deleted: [], newStart: Number(m[3]), added: [] };
				file.hunks.push(hunk);
			}
			continue;
		}
		if (line.startsWith('\\')) {
			continue; // \ No newline at end of file
		}
		hunk = undefined;
		if (line.startsWith('--- ')) {
			file.oldPath = headerPath(line.slice(4), 'a/');
		} else if (line.startsWith('+++ ')) {
			file.newPath = headerPath(line.slice(4), 'b/');
		} else if (line.startsWith('rename from ')) {
			file.oldPath = unquotePath(line.slice('rename from '.length));
		} else if (line.startsWith('rename to ')) {
			file.newPath = unquotePath(line.slice('rename to '.length));
		} else if (line.startsWith('new file mode')) {
			file.added = true;
		} else if (line.startsWith('deleted file mode')) {
			file.deletedFile = true;
		} else if (line.startsWith('Binary files ')) {
			file.binary = true;
		}
	}
	return files.map(({ added, deletedFile, ...f }) => ({
		...f,
		oldPath: added ? undefined : f.oldPath,
		newPath: deletedFile ? undefined : f.newPath,
	}));
}

/** What `diffWorkingTree` compares with: the files on disk, untracked ones included. */
export const WORKING_TREE = 'working tree';

/**
 * The hunks between a commit and the working tree. Untracked files (not ignored) count as
 * added; git diff leaves them out. `read` gets one by its repository-relative path.
 */
export async function diffWorkingTree(git: Git, read: (path: string) => Promise<string>, a: string): Promise<FileDiff[]> {
	const [tracked, untracked] = await Promise.all([
		git.run([...DIFF_ARGS, a, '--']),
		git.run(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z']),
	]);
	const files = parseDiff(tracked);
	for (const p of untracked.split('\0').filter(Boolean)) {
		const text = await read(p).catch(() => undefined);
		if (text === undefined || text.includes('\0')) {
			continue; // gone already, or binary
		}
		const lines = splitLines(text);
		files.push({ newPath: p, binary: false, hunks: lines.length ? [{ oldStart: 0, deleted: [], newStart: 1, added: lines }] : [] });
	}
	return files;
}

