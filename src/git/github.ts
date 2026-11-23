// Open pull requests, from the GitHub CLI. No vscode import.
import { execFile } from 'node:child_process';

export interface PullRequest {
	number: number;
	title: string;
	/** the branch the pull request is from */
	head: string;
	/** the branch it merges into: the branch below it in a stack */
	base: string;
	url: string;
	draft: boolean;
}

/** `gh pr list --json …` output as pull requests; anything malformed is skipped. */
export function parsePullRequests(json: string): PullRequest[] {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) {
		return [];
	}
	const prs: PullRequest[] = [];
	for (const p of raw) {
		if (p && typeof p.number === 'number' && typeof p.headRefName === 'string' && typeof p.baseRefName === 'string') {
			prs.push({ number: p.number, title: String(p.title ?? ''), head: p.headRefName, base: p.baseRefName, url: String(p.url ?? ''), draft: Boolean(p.isDraft) });
		}
	}
	return prs;
}

/**
 * The repository's open pull requests, or undefined when `gh` is missing, not logged in, too
 * slow, or the repository isn't on GitHub.
 */
export function openPullRequests(cwd: string, ghPath = 'gh', timeoutMs = 10000): Promise<PullRequest[] | undefined> {
	return new Promise((resolve) => {
		const args = ['pr', 'list', '--state', 'open', '--limit', '300', '--json', 'number,title,headRefName,baseRefName,url,isDraft'];
		execFile(ghPath, args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout) => {
			resolve(error ? undefined : parsePullRequests(stdout));
		});
	});
}
