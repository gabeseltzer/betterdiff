// The Commits view's graph as its webview (media/graph.js) draws it. No vscode import.
import { type LaneColor, type LaneRow, layoutLanes } from '../lanes';
import { ago } from './nodes';
import type { CommitGraph } from './roots';

export interface BadgeModel {
	label: string;
	color: LaneColor;
	/** the branch Checkout Branch checks out */
	branch?: string;
	current: boolean;
	prNumber?: number;
	prUrl?: string;
}

export interface RowModel {
	/** the node's id: what the webview asks for files with */
	id: string;
	kind: 'commit' | 'uncommitted' | 'boundary';
	sha?: string;
	subject: string;
	description?: string;
	tooltip: string;
	/** the checked-out commit */
	head: boolean;
	merge: boolean;
	badges: BadgeModel[];
	lanes: LaneRow;
}

/** One row per commit, newest first, with its lanes laid out. */
export function graphRows(graph: CommitGraph): RowModel[] {
	const lanes = layoutLanes(graph.rows.map((r) => ({ id: r.sha, parents: r.parents })), (id) => graph.colors.get(id));
	return graph.rows.map((row, i): RowModel => {
		const { node } = row;
		if (node.kind === 'comparison') {
			return { id: node.id, kind: 'uncommitted', subject: node.label, tooltip: 'What is on disk and not committed', head: false, merge: false, badges: [], lanes: lanes[i] };
		}
		const { commit } = node;
		return {
			id: node.id,
			kind: row.boundary ? 'boundary' : 'commit',
			sha: commit.sha,
			subject: commit.subject,
			description: row.note ?? `${commit.author} · ${ago(commit.date)}`,
			tooltip: `${commit.sha}\n${commit.author}, ${new Date(commit.date).toLocaleString()}\n\n${commit.subject}`,
			head: row.head,
			merge: commit.parents.length > 1,
			badges: row.badges.map((b) => ({ label: b.label, color: b.color, branch: b.branch, current: b.current, prNumber: b.pr?.number, prUrl: b.pr?.url })),
			lanes: lanes[i],
		};
	});
}
