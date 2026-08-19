import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { readFirmwareVersion, saveFirmwareSnapshot } from '../projectBuild';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Reads a generated firmware version', () => {
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mpytools-version-'));
		try {
			const versionFile = path.join(temporaryRoot, 'fw_version.py');
			fs.writeFileSync(versionFile, "FW_VERSION = 'v1.0.1-alpha.1+s12345678'\n", 'utf-8');
			assert.strictEqual(readFirmwareVersion(versionFile), 'v1.0.1-alpha.1+s12345678');
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	test('Stores one local snapshot per firmware version', () => {
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mpytools-snapshot-'));
		try {
			const sourceRoot = path.join(temporaryRoot, 'src');
			const versionFile = path.join(sourceRoot, 'generated', 'fw_version.py');
			fs.mkdirSync(path.dirname(versionFile), { recursive: true });
			fs.writeFileSync(versionFile, "FW_VERSION = 'v1.0.1-alpha.1+s12345678'\n", 'utf-8');
			fs.writeFileSync(path.join(sourceRoot, 'main.py'), 'print(1)\n', 'utf-8');

			const prepared = {
				version: 'v1.0.1-alpha.1+s12345678',
				versionFilePath: versionFile,
				snapshotDirectory: path.join(temporaryRoot, '.save', 'mpytools-builds'),
				autoSnapshot: true
			};
			const first = saveFirmwareSnapshot(temporaryRoot, prepared);
			const second = saveFirmwareSnapshot(temporaryRoot, prepared);

			assert.strictEqual(first?.created, true);
			assert.strictEqual(second?.created, false);
			assert.ok(first && fs.existsSync(path.join(first.path, 'src', 'main.py')));
			assert.ok(first && fs.existsSync(path.join(first.path, 'build-info.json')));
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});
});
