// Lays a commit graph out in lanes, in the manner of VS Code's Source Control Graph: every commit
// still waiting for a parent holds a lane, and lanes close up to the left as they end. Pure.

/** The checked-out branch, the base branch, or one of LANE_COLORS rotating colors. */
export type LaneColor = 'ref' | 'base' | number;
export const LANE_COLORS = 5;

/** A line through one row. Columns count from 0 at the left. */
export type Segment =
	/** past the commit: from the top at `from` to the bottom at `to` (to the left of it, or the same) */
	| { kind: 'through'; from: number; to: number; color: LaneColor }
	/** from the top at `from` into the commit */
	| { kind: 'in'; from: number; color: LaneColor }
	/** from the commit to the bottom at `to` */
	| { kind: 'out'; to: number; color: LaneColor };

export interface LaneRow {
	/** the column the commit's circle is in */
	circle: number;
	color: LaneColor;
	/** how many columns the row needs */
	columns: number;
	segments: Segment[];
	/** the lanes that leave the row at the bottom, by column */
	below: LaneColor[];
}

export interface GraphCommit {
	id: string;
	/** the first is the one the commit's own lane goes on to */
	parents: readonly string[];
}

/**
 * One row per commit. `commits` list children before their parents (git's --topo-order). A
 * commit `tipColor` knows (a branch's tip) starts that color; other lanes keep the color they
 * have, and new ones take the next rotating color. A parent that never comes leaves its lane open.
 */
export function layoutLanes(commits: readonly GraphCommit[], tipColor: (id: string) => LaneColor | undefined): LaneRow[] {
	let lanes: { id: string; color: LaneColor }[] = [];
	let rotating = 0;
	const fresh = () => rotating++ % LANE_COLORS;

	return commits.map((commit) => {
		// several children wait for this commit: it sits in the leftmost of their lanes
		const waiting = lanes.findIndex((l) => l.id === commit.id);
		const circle = waiting === -1 ? lanes.length : waiting;
		const color = tipColor(commit.id) ?? lanes[waiting]?.color ?? fresh();
		const segments: Segment[] = [];
		const out: typeof lanes = [];
		const onward = () => {
			if (commit.parents.length) {
				out.push({ id: commit.parents[0], color });
				segments.push({ kind: 'out', to: out.length - 1, color });
			}
		};

		lanes.forEach((lane, column) => {
			if (lane.id !== commit.id) {
				out.push(lane);
				segments.push({ kind: 'through', from: column, to: out.length - 1, color: lane.color });
				return;
			}
			segments.push({ kind: 'in', from: column, color: lane.color });
			if (column === circle) {
				onward();
			}
		});
		if (waiting === -1) {
			onward();
		}
		// a merge: its other parents get lanes of their own
		for (const parent of commit.parents.slice(1)) {
			const parentColor = tipColor(parent) ?? fresh();
			out.push({ id: parent, color: parentColor });
			segments.push({ kind: 'out', to: out.length - 1, color: parentColor });
		}

		const row: LaneRow = { circle, color, columns: Math.max(lanes.length, out.length, circle + 1), segments, below: out.map((l) => l.color) };
		lanes = out;
		return row;
	});
}
