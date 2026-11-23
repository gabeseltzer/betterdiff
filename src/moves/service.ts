// Moves per comparison, computed once and kept. No vscode import.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Git } from '../git/exec';
import { diffCommits, diffWorkingTree } from '../git/hunks';
import { WORKING_TREE } from '../git/model';
import { type MoveIndex, indexMoves } from './annotate';
import { type DetectOptions, detectMoves } from './detect';

const MAX_ENTRIES = 60;

export class MovesService {
	private readonly cache = new Map<string, Promise<MoveIndex>>();

	/** The code that moved between `base` and `head`, within files and between them. */
	get(git: Git, base: string, head: string, options: DetectOptions): Promise<MoveIndex> {
		const key = JSON.stringify([git.cwd, base, head, options]);
		let hit = this.cache.get(key);
		if (!hit) {
			hit = this.compute(git, base, head, options);
			// a failure isn't kept: the next request tries again
			hit.catch(() => this.cache.delete(key));
			this.cache.set(key, hit);
			for (const old of this.cache.keys()) {
				if (this.cache.size <= MAX_ENTRIES) {
					break;
				}
				this.cache.delete(old);
			}
		}
		return hit;
	}

	private async compute(git: Git, base: string, head: string, options: DetectOptions): Promise<MoveIndex> {
		const files = head === WORKING_TREE
			? await diffWorkingTree(git, (p) => fs.promises.readFile(path.join(git.cwd, p), 'utf8'), base)
			: await diffCommits(git, base, head);
		return indexMoves(detectMoves(files, { ...options, sameFile: true }));
	}

	/** The files on disk changed: comparisons with the working tree are stale. */
	forgetWorkingTree(): void {
		for (const key of [...this.cache.keys()]) {
			if ((JSON.parse(key) as string[])[2] === WORKING_TREE) {
				this.cache.delete(key);
			}
		}
	}
}
