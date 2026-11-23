// The top-level nodes of the three views. No vscode import.
import type { Git } from '../git/exec';
import type { PullRequest } from '../git/github';
import { WORKING_TREE, aheadBehind, baseBranch, branchRef, currentBranch, localStackParents, mergeBase, resolve, short, upstreamOf } from '../git/model';
import { buildStack, mergeLinks } from '../stack';
import { type ComparisonNode, type Node, type Settings, commitNodes, message, uncommittedNode } from './nodes';

export interface RootContext {
	git: Git;
	root: string;
	settings: Settings;
	/** the configured base branch; empty to detect it */
	baseBranch: string;
	/** open pull requests; undefined when they can't be had (or aren't wanted) */
	pullRequests(): Promise<PullRequest[] | undefined>;
}

interface Head {
	/** the checked-out branch; undefined when detached */
	branch?: string;
	/** the branch, or "detached at 1a2b3c4" */
	name: string;
	sha: string;
	/** what comparisons end at: the commit, or the working tree */
	head: string;
	headLabel: string;
}

async function headOf({ git, settings }: RootContext): Promise<Head | undefined> {
	const sha = await resolve(git, 'HEAD');
	if (!sha) {
		return undefined;
	}
	const branch = await currentBranch(git);
	const name = branch ?? `detached at ${short(sha)}`;
	return settings.includeWorkingTree
		? { branch, name, sha, head: WORKING_TREE, headLabel: 'working tree' }
		: { branch, name, sha, head: sha, headLabel: branch ?? short(sha) };
}

const NO_COMMITS = (view: string) => [message(`${view}/no-head`, 'No commits yet', { icon: 'info' })];
const NO_BASE = (view: string) => [message(`${view}/no-base`, 'No base branch found', {
	description: 'set one', icon: 'warning', command: { command: 'betterdiff.setBaseBranch', title: 'Set Base Branch…' },
})];

/** Branch view: the branch against its merge base with the base branch, and against its upstream. */
export async function branchRoots(ctx: RootContext): Promise<Node[]> {
	const { git, root } = ctx;
	const head = await headOf(ctx);
	if (!head) {
		return NO_COMMITS('branch');
	}
	const nodes: Node[] = [];
	const uncommitted = head.head === WORKING_TREE ? ' + uncommitted' : '';

	const base = await baseBranch(git, ctx.baseBranch);
	const fork = base && await mergeBase(git, base, head.sha);
	if (!base) {
		nodes.push(...NO_BASE('branch'));
	} else if (!fork) {
		nodes.push(message('branch/unrelated', `No common ancestor with ${base}`, { icon: 'warning' }));
	} else {
		nodes.push({
			kind: 'comparison', id: 'branch/base', git, root, icon: 'git-merge', expanded: true, scope: true,
			label: `${head.name} ↔ ${base}`,
			description: `merge base ${short(fork)}${uncommitted}`,
			tooltip: `Everything ${head.name} changed since it forked from ${base} (at ${short(fork)})`,
			cmp: { base: fork, head: head.head, baseLabel: `${base} @ ${short(fork)}`, headLabel: head.headLabel },
		});
	}

	const upstream = head.branch && await upstreamOf(git, head.branch);
	const upstreamSha = upstream && await resolve(git, upstream);
	if (!upstream || !upstreamSha) {
		nodes.push(message('branch/no-upstream', head.branch ? `${head.branch} is not on the remote` : 'Detached HEAD: no remote branch', { icon: 'cloud' }));
	} else {
		const { ahead, behind } = await aheadBehind(git, upstreamSha, head.sha);
		nodes.push({
			kind: 'comparison', id: 'branch/upstream', git, root, icon: 'cloud', scope: true,
			label: `${head.name} ↔ ${upstream}`,
			description: `↑${ahead} ↓${behind}${uncommitted}`,
			tooltip: `What differs between ${upstream} (left) and ${head.name} (right): ${ahead} to push, ${behind} to pull`,
			cmp: { base: upstreamSha, head: head.head, baseLabel: upstream, headLabel: head.headLabel },
		});
	}
	return nodes;
}

/** Commits view: the branch's commits since the merge base, to walk through one by one. */
export async function commitRoots(ctx: RootContext): Promise<Node[]> {
	const { git, root, settings } = ctx;
	const head = await headOf(ctx);
	if (!head) {
		return NO_COMMITS('commits');
	}
	const base = await baseBranch(git, ctx.baseBranch);
	const fork = base && await mergeBase(git, base, head.sha);
	if (!base || !fork) {
		return NO_BASE('commits');
	}
	const nodes: Node[] = await commitNodes(git, root, { base: fork, head: head.sha }, 'commits', settings);
	const uncommitted = settings.includeWorkingTree ? await uncommittedNode(git, root, head.sha, head.branch ?? short(head.sha), 'commits') : undefined;
	if (uncommitted) {
		// the newest step of the walk
		if (settings.commitsOrder === 'newestFirst') {
			nodes.unshift(uncommitted);
		} else {
			nodes.push(uncommitted);
		}
	}
	return nodes.length ? nodes : [message('commits/empty', `No commits since ${base}`, { icon: 'info' })];
}

/** Stack view: every branch of the stack against the branch below it, the top of the stack first. */
export async function stackRoots(ctx: RootContext): Promise<Node[]> {
	const { git, root } = ctx;
	const head = await headOf(ctx);
	if (!head) {
		return NO_COMMITS('stack');
	}
	if (!head.branch) {
		return [message('stack/detached', 'Detached HEAD: check out a branch to see its stack', { icon: 'info' })];
	}
	const trunkRef = await baseBranch(git, ctx.baseBranch);
	if (!trunkRef) {
		return NO_BASE('stack');
	}
	// origin/master is the branch pull requests call master
	const trunk = await resolve(git, `refs/remotes/${trunkRef}`) ? trunkRef.slice(trunkRef.indexOf('/') + 1) : trunkRef;
	if (head.branch === trunk) {
		return [message('stack/trunk', `On ${trunk}: nothing is stacked below it`, { icon: 'info' })];
	}

	const [prs, fromGit] = await Promise.all([ctx.pullRequests(), localStackParents(git, head.branch, trunkRef, trunk)]);
	const layers = buildStack(head.branch, trunk, mergeLinks(fromGit, prs ?? []));

	const nodes: Node[] = [];
	for (const layer of [...layers].reverse()) {
		const id = `stack/${layer.branch}`;
		const ref = layer.current ? head.branch : await branchRef(git, layer.branch);
		const parentRef = layer.parent === trunk ? trunkRef : await branchRef(git, layer.parent);
		const sha = ref && await resolve(git, ref);
		const parentSha = parentRef && await resolve(git, parentRef);
		const fork = sha && parentSha && await mergeBase(git, parentSha, sha);
		if (!sha || !parentSha || !fork) {
			const missing = !sha ? layer.branch : !parentSha ? layer.parent : undefined;
			nodes.push(message(id, layer.branch, { description: missing ? `← ${layer.parent} · ${missing} isn't fetched` : `← ${layer.parent} · no common ancestor`, icon: 'warning' }));
			continue;
		}
		// The parent moved on (it was rebased or got new commits): the diff is still this
		// branch's own changes, but the branch needs restacking. Being behind the trunk is normal.
		const behindParent = layer.parent !== trunk && fork !== parentSha;
		const description = [`← ${layer.parent}`, layer.pr && `#${layer.pr.number}`, layer.pr?.draft && 'draft', behindParent && 'behind parent'].filter(Boolean).join(' · ');
		const onDisk = layer.current && head.head === WORKING_TREE;
		const node: ComparisonNode = {
			kind: 'comparison', id, git, root, scope: true, expanded: layer.current,
			icon: layer.current ? 'target' : 'git-branch',
			label: layer.branch,
			description,
			tooltip: [
				`${layer.branch} against ${layer.parent} (merge base ${short(fork)})`,
				layer.pr && `#${layer.pr.number} ${layer.pr.title}`,
				layer.source === 'git' ? 'Stacked according to git history' : 'Stacked according to its pull request',
				behindParent && `${layer.parent} has commits ${layer.branch} doesn't: restack it`,
			].filter(Boolean).join('\n'),
			contextValue: layer.pr?.url ? 'betterdiff.layer.pr' : 'betterdiff.layer',
			pr: layer.pr,
			commits: { base: fork, head: sha },
			cmp: { base: fork, head: onDisk ? WORKING_TREE : sha, baseLabel: layer.parent, headLabel: onDisk ? 'working tree' : layer.branch },
		};
		nodes.push(node);
	}
	if (layers.length === 1 && !prs?.length) {
		nodes.push(message('stack/alone', 'No other branches in this stack', { icon: 'info' }));
	}
	return nodes;
}
