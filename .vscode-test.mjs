import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	useInstallation: process.env.MPYTOOLS_VSCODE_EXECUTABLE
		? { fromPath: process.env.MPYTOOLS_VSCODE_EXECUTABLE }
		: undefined,
	launchArgs: process.platform === 'linux' ? ['--disable-gpu'] : [],
});
