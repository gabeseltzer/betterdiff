// Turns detected moves into what each side of a file's diff shows. Pure.
//
// The model is git's `--color-moved=dimmed-zebra --color-moved-ws=allow-indentation-change`:
// lines that only moved are dimmed, so what really changed stands out; neighboring moved blocks
// alternate between two colors; a line changed on the way keeps its normal diff color.
import type { DetectedMove } from './detect';

export interface MoveAnnotation {
	/** identifies the move across both sides */
	id: number;
	/** first line of the block on this side, 1-based */
	start: number;
	/** number of lines in the block on this side */
	count: number;
	/** 1-based lines of this side that match the other side: the ones to dim */
	matchedLines: number[];
	/** which of the two alternating colors */
	zebra: 0 | 1;
	/** some lines changed on the way */
	edited: boolean;
	/** where the block is on the other side */
	other: { path: string; start: number; count: number };
}

export interface FileMoves {
	/** blocks that left this file, by line at the base (shown on the left) */
	left: MoveAnnotation[];
	/** blocks that arrived in this file, by line at the head (shown on the right) */
	right: MoveAnnotation[];
}

export interface MoveIndex {
	moves: readonly DetectedMove[];
	/** by path at the base */
	left: Map<string, MoveAnnotation[]>;
	/** by path at the head */
	right: Map<string, MoveAnnotation[]>;
}

export function indexMoves(moves: readonly DetectedMove[]): MoveIndex {
	const left = new Map<string, MoveAnnotation[]>();
	const right = new Map<string, MoveAnnotation[]>();
	const push = (map: Map<string, MoveAnnotation[]>, path: string, a: MoveAnnotation) => map.set(path, [...(map.get(path) ?? []), a]);
	moves.forEach((m, id) => {
		const { source, dest } = m;
		push(left, source.path, {
			id, start: source.start, count: source.lines.length, zebra: 0, edited: m.edited,
			matchedLines: m.sourceMatched.map((o) => source.start + o),
			other: { path: dest.path, start: dest.start, count: dest.lines.length },
		});
		push(right, dest.path, {
			id, start: dest.start, count: dest.lines.length, zebra: 0, edited: m.edited,
			matchedLines: m.destMatched.map((o) => dest.start + o),
			other: { path: source.path, start: source.start, count: source.lines.length },
		});
	});
	for (const list of [...left.values(), ...right.values()]) {
		list.sort((a, b) => a.start - b.start);
		list.forEach((a, i) => { a.zebra = (i % 2) as 0 | 1; });
	}
	return { moves, left, right };
}

/** The annotation whose block has `line` (1-based) in it. */
export function annotationAt(list: readonly MoveAnnotation[] | undefined, line: number): MoveAnnotation | undefined {
	return list?.find((a) => line >= a.start && line < a.start + a.count);
}

/** `12` or `12-18`. */
export function lineSpan(start: number, count: number): string {
	return count > 1 ? `${start}-${start + count - 1}` : `${start}`;
}

/** Moved lines per path, for the file list: lines that arrived (by head path) or left (by base path). */
export function movedLineCount(index: MoveIndex, path: string, oldPath?: string): number {
	const sum = (list?: MoveAnnotation[]) => (list ?? []).reduce((n, a) => n + a.matchedLines.length, 0);
	return Math.max(sum(index.right.get(path)), sum(index.left.get(oldPath ?? path)));
}
