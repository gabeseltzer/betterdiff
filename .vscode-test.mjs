// Integration tests: run inside a real VS Code (downloaded to .vscode-test/ on first use), with a
// throwaway repository of three stacked branches as the workspace. Compile first (npm run
// test:integration does): the fixture comes from out/test/repo.js.
import { createRequire } from 'node:module';
import { defineConfig } from '@vscode/test-cli';

const { stackedRepo } = createRequire(import.meta.url)('./out/test/repo.js');
const { repo, origin } = stackedRepo();
process.on('exit', () => {
	try {
		repo.dispose();
		origin.dispose();
	} catch {
		// still open somewhere: the OS clears its temp folder
	}
});

export default defineConfig({
	files: 'out/test/integration/**/*.test.js',
	workspaceFolder: repo.dir,
	mocha: { ui: 'tdd', timeout: 60000 },
	launchArgs: ['--disable-extensions'],
});
