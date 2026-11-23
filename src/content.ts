// Read-only documents for the sides of a diff: a file at a commit, an empty file, or a block of
// moved code.
import * as vscode from 'vscode';
import type { Git } from './git/exec';
import { fileAt } from './git/model';

export const SCHEME = 'betterdiff';

interface Query {
	/** repository root */
	root?: string;
	/** the commit the file is read at; empty for a file that doesn't exist on this side */
	rev?: string;
	/** the other side's revision: keeps the URIs of two comparisons apart */
	vs?: string;
	/** a block of moved code, by its key in `blocks` */
	block?: string;
}

const query = (uri: vscode.Uri): Query => {
	try {
		return JSON.parse(uri.query) as Query;
	} catch {
		return {};
	}
};

/** `path` (relative to `root`) as it is at `rev`. */
export function revUri(root: string, rev: string, path: string, vs: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: '/' + path, query: JSON.stringify({ root, rev, vs } satisfies Query) });
}

/** An empty document named like `path`: the missing side of an added or deleted file. */
export function emptyUri(root: string, path: string, vs: string): vscode.Uri {
	return revUri(root, '', path, vs);
}

export class ContentProvider implements vscode.TextDocumentContentProvider {
	private readonly blocks = new Map<string, string>();
	private nextBlock = 0;

	constructor(private readonly gitFor: (root: string) => Git) { }

	/** A document with `text` in it, named like `path` (for its language). */
	blockUri(path: string, text: string): vscode.Uri {
		const key = String(this.nextBlock++);
		this.blocks.set(key, text);
		// the oldest go once there are many: a closed compare view doesn't need its text
		for (const old of this.blocks.keys()) {
			if (this.blocks.size <= 40) {
				break;
			}
			this.blocks.delete(old);
		}
		return vscode.Uri.from({ scheme: SCHEME, path: '/' + path, query: JSON.stringify({ block: key } satisfies Query) });
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const q = query(uri);
		if (q.block !== undefined) {
			return this.blocks.get(q.block) ?? '';
		}
		if (!q.root || !q.rev) {
			return '';
		}
		return fileAt(this.gitFor(q.root), q.rev, uri.path.slice(1));
	}
}
