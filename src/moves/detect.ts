// Finds code that moved from one place to another between two commits.
// Pure: it works on the hunks git.ts parses.
//
// Every run of deleted lines is a possible source, every run of added lines in another file a
// possible destination. A block starts from a seed (an added line equal, after normalizing, to
// a deleted line, with enough letters and digits that the match means something). It grows in
// both directions while lines match. A line that doesn't match is let through as an edit when
// both sides match again within `lookahead` lines. Blocks are then picked longest first, and
// each deleted or added line belongs to at most one move.
import type { FileDiff } from '../git/hunks';

export interface MoveSide {
	path: string;
	/** first line, 1-based: in the file at A for a source, at B for a destination */
	start: number;
	/** the block's lines as they are on that side */
	lines: string[];
}

export interface DetectedMove {
	source: MoveSide;
	dest: MoveSide;
	/** lines that match on both sides */
	matched: number;
	/** some lines were changed on the way */
	edited: boolean;
	/** moved within one file (only with `sameFile`) */
	sameFile: boolean;
	/** offsets into `source.lines` of the lines that match (ignoring whitespace) */
	sourceMatched: number[];
	/** offsets into `dest.lines` of the lines that match */
	destMatched: number[];
}

export interface DetectOptions {
	/** a move has at least this many matching lines */
	minLines?: number;
	/** and its matching lines at least this many letters and digits (git's --color-moved uses 20) */
	minAlnum?: number;
	/** how far ahead a changed line may be bridged */
	lookahead?: number;
	/** a seed line needs at least this many letters and digits */
	seedAlnum?: number;
	/**
	 * Also report moves within one file. Lines deleted and added in the same hunk are an edit in
	 * place (a re-indent, say), never a move.
	 */
	sameFile?: boolean;
}

const DEFAULTS: Required<DetectOptions> = { minLines: 3, minAlnum: 20, lookahead: 2, seedAlnum: 4, sameFile: false };
/** Lines more common than this among the deleted lines (`}`, `return;`, …) don't seed blocks. */
const MAX_SEED_OCCURRENCES = 64;

interface Run {
	/** the file's identity across the rename: its path at A, or at B if it is new */
	file: string;
	/** which hunk of its file it came from */
	hunk: number;
	path: string;
	start: number;
	lines: string[];
	norm: string[];
	alnum: number[];
}

export const normalize = (line: string) => line.trim().replace(/\s+/g, ' ');
const alnumCount = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;

function run(file: string, hunk: number, path: string, start: number, lines: string[]): Run {
	const norm = lines.map(normalize);
	return { file, hunk, path, start, lines, norm, alnum: norm.map(alnumCount) };
}

/** Runs of deleted lines (by their path at A) and of added lines (by their path at B). */
function runsOf(files: readonly FileDiff[]): { deleted: Run[]; added: Run[] } {
	const deleted: Run[] = [];
	const added: Run[] = [];
	for (const f of files) {
		if (f.binary) {
			continue;
		}
		const identity = f.oldPath ?? f.newPath!;
		f.hunks.forEach((h, hi) => {
			if (h.deleted.length && f.oldPath !== undefined) {
				deleted.push(run(identity, hi, f.oldPath, h.oldStart, h.deleted));
			}
			if (h.added.length && f.newPath !== undefined) {
				added.push(run(identity, hi, f.newPath, h.newStart, h.added));
			}
		});
	}
	return { deleted, added };
}

interface Candidate {
	dest: Run;
	source: Run;
	/** [start, end) indexes into the runs' lines */
	d: [number, number];
	s: [number, number];
	matched: number;
	alnum: number;
	edited: boolean;
	pairs: [number, number][];
}

/** Grows a block from the seed (di, si) in one direction; returns the matched index pairs. */
function grow(dest: Run, source: Run, di: number, si: number, step: 1 | -1, lookahead: number): [number, number][] {
	const pairs: [number, number][] = [];
	const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < dest.lines.length && j < source.lines.length;
	let i = di + step;
	let j = si + step;
	while (inside(i, j)) {
		if (dest.norm[i] === source.norm[j]) {
			pairs.push([i, j]);
			i += step;
			j += step;
			continue;
		}
		// bridge changed lines: the nearest pair that matches again (a block still needs a
		// meaningful seed and minAlnum, so landing on `}` is fine)
		let bridged = false;
		for (let d = 1; d <= 2 * lookahead && !bridged; d++) {
			for (let a = 0; a <= Math.min(d, lookahead); a++) {
				const b = d - a;
				const ni = i + a * step;
				const nj = j + b * step;
				if (b <= lookahead && inside(ni, nj) && dest.norm[ni] === source.norm[nj]) {
					i = ni;
					j = nj;
					bridged = true;
					break;
				}
			}
		}
		if (!bridged) {
			break;
		}
	}
	return pairs;
}

export function detectMoves(files: readonly FileDiff[], options: DetectOptions = {}): DetectedMove[] {
	const opt = { ...DEFAULTS, ...options };
	const { deleted, added } = runsOf(files);

	// every deleted line that can seed a block, by its normalized text
	const index = new Map<string, { run: number; at: number }[]>();
	deleted.forEach((r, ri) => r.norm.forEach((n, at) => {
		if (r.alnum[at] >= opt.seedAlnum) {
			const list = index.get(n) ?? [];
			list.push({ run: ri, at });
			index.set(n, list);
		}
	}));

	const candidates: Candidate[] = [];
	const seen = new Set<string>(); // dest run, dest line, source run, source line already in a block
	added.forEach((dest, dri) => dest.norm.forEach((n, di) => {
		const hits = index.get(n);
		if (!hits || hits.length > MAX_SEED_OCCURRENCES || dest.alnum[di] < opt.seedAlnum) {
			return;
		}
		for (const { run: sri, at: si } of hits) {
			const source = deleted[sri];
			const sameFile = source.file === dest.file;
			if ((sameFile && (!opt.sameFile || source.hunk === dest.hunk)) || seen.has(`${dri}:${di}:${sri}:${si}`)) {
				continue;
			}
			const pairs = [...grow(dest, source, di, si, -1, opt.lookahead).reverse(), [di, si] as [number, number], ...grow(dest, source, di, si, 1, opt.lookahead)];
			for (const [i, j] of pairs) {
				seen.add(`${dri}:${i}:${sri}:${j}`);
			}
			const d: [number, number] = [pairs[0][0], pairs.at(-1)![0] + 1];
			const s: [number, number] = [pairs[0][1], pairs.at(-1)![1] + 1];
			candidates.push({
				dest, source, d, s,
				matched: pairs.length,
				pairs,
				alnum: pairs.reduce((sum, [i]) => sum + dest.alnum[i], 0),
				edited: d[1] - d[0] !== pairs.length || s[1] - s[0] !== pairs.length,
			});
		}
	}));

	// longest first; a line belongs to one move at most
	candidates.sort((x, y) => y.matched - x.matched || y.alnum - x.alnum);
	const taken = new Map<Run, [number, number][]>();
	const overlaps = (r: Run, [a, b]: [number, number]) => (taken.get(r) ?? []).some(([c, d]) => a < d && c < b);
	const moves: DetectedMove[] = [];
	for (const c of candidates) {
		if (c.matched < opt.minLines || c.alnum < opt.minAlnum || overlaps(c.dest, c.d) || overlaps(c.source, c.s)) {
			continue;
		}
		taken.set(c.dest, [...(taken.get(c.dest) ?? []), c.d]);
		taken.set(c.source, [...(taken.get(c.source) ?? []), c.s]);
		moves.push({
			source: { path: c.source.path, start: c.source.start + c.s[0], lines: c.source.lines.slice(...c.s) },
			dest: { path: c.dest.path, start: c.dest.start + c.d[0], lines: c.dest.lines.slice(...c.d) },
			matched: c.matched,
			edited: c.edited,
			sameFile: c.source.file === c.dest.file,
			sourceMatched: c.pairs.map(([, j]) => j - c.s[0]),
			destMatched: c.pairs.map(([i]) => i - c.d[0]),
		});
	}
	// by destination, then source: the order a diff view walks them
	return moves.sort((x, y) => x.dest.path.localeCompare(y.dest.path) || x.dest.start - y.dest.start || x.source.path.localeCompare(y.source.path) || x.source.start - y.source.start);
}
