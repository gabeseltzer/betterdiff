// Orders stacked branches. Pure: the links come from pull requests (a PR's base branch is the
// branch below it) and from git history (git/model.ts localStackParents).
import type { PullRequest } from './git/github';

export interface ParentLink {
	/** the branch this one is stacked on */
	parent: string;
	/** where the link comes from */
	source: 'pr' | 'git';
	pr?: PullRequest;
}

export interface StackLayer {
	branch: string;
	parent: string;
	source: 'pr' | 'git';
	pr?: PullRequest;
	current: boolean;
	/** 0 for the branch on the trunk, 1 for the one on top of it, … */
	depth: number;
}

/** Pull requests win over history: after a rebase below, history no longer shows the stack. */
export function mergeLinks(fromGit: ReadonlyMap<string, string>, prs: readonly PullRequest[]): Map<string, ParentLink> {
	const links = new Map<string, ParentLink>();
	for (const [branch, parent] of fromGit) {
		links.set(branch, { parent, source: 'git' });
	}
	for (const pr of prs) {
		if (pr.head !== pr.base) {
			links.set(pr.head, { parent: pr.base, source: 'pr', pr });
		}
	}
	return links;
}

/**
 * The stack `current` is in, bottom first: the branches below it down to `trunk`, itself, then
 * every branch stacked on top of it (a branch with two children lists one subtree after the
 * other). A branch nothing links is taken to sit on the trunk.
 */
export function buildStack(current: string, trunk: string, links: ReadonlyMap<string, ParentLink>): StackLayer[] {
	// down from the current branch
	const below: { branch: string; link: ParentLink }[] = [];
	const seen = new Set<string>([current]);
	let at = current;
	for (; ;) {
		const link = links.get(at) ?? { parent: trunk, source: 'git' as const };
		below.push({ branch: at, link });
		if (link.parent === trunk || seen.has(link.parent) || !links.has(link.parent)) {
			break;
		}
		at = link.parent;
		seen.add(at);
	}
	const layers: StackLayer[] = below.reverse().map(({ branch, link }, depth) => ({ branch, ...link, current: branch === current, depth }));

	// up: everything whose chain of parents reaches the current branch
	const children = new Map<string, string[]>();
	for (const [branch, link] of links) {
		children.set(link.parent, [...(children.get(link.parent) ?? []), branch]);
	}
	const climb = (branch: string, depth: number) => {
		for (const child of (children.get(branch) ?? []).sort()) {
			if (seen.has(child)) {
				continue;
			}
			seen.add(child);
			layers.push({ branch: child, ...links.get(child)!, current: false, depth });
			climb(child, depth + 1);
		}
	};
	climb(current, layers.length);
	return layers;
}
