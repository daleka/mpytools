import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createZipArchive } from '../archive';
import { BufferedTextWriter } from '../bufferedOutput';
import { decodeMpyAbi } from '../micropythonInfo';
import { parseFileSystemEntry } from '../deviceFiles';
import {
  describePort,
  normalizePortTarget,
  parseMpremotePortList,
  stablePortTarget
} from '../ports';
import { ProcessExecutionError, runProcess } from '../processRunner';
import { restartMicroPythonInRepl, runReplCommands } from '../replControl';
import {
  conflictingProjectEntryPoint,
  resolveProjectCandidate,
  resolveProjectEntryPoint
} from '../projectSelection';
import {
  assertUniqueOutputPaths,
  clearBuildStorage,
  collectSourceInventory,
  estimateUploadTimeoutMs,
  isPathInside,
  isRootStartupPythonFile,
  resolveBuildStoragePaths
} from '../buildWorkspace';

suite('MPyTools core', () => {
  test('keeps absolute Unix serial paths idempotent', () => {
    assert.strictEqual(normalizePortTarget('/dev/ttyACM0', 'linux'), '/dev/ttyACM0');
    assert.strictEqual(normalizePortTarget('/dev/serial/by-id/board', 'linux'), '/dev/serial/by-id/board');
    assert.strictEqual(normalizePortTarget('ttyACM0', 'linux'), '/dev/ttyACM0');
    assert.strictEqual(normalizePortTarget('/dev/cu.usbmodem01', 'darwin'), '/dev/cu.usbmodem01');
    assert.strictEqual(normalizePortTarget('COM7', 'win32'), 'COM7');
    assert.strictEqual(normalizePortTarget('id:1234', 'linux'), 'id:1234');
  });

  test('parses and prioritises structured mpremote port data', () => {
    const ports = parseMpremotePortList([
      'warning: backend emitted a diagnostic line',
      '/dev/ttyS0 None 0000:0000 None None',
      '/dev/ttyACM0 389434743434 f055:9800 MicroPython Pyboard Virtual Comm Port'
    ].join('\n'));
    assert.strictEqual(ports[0].path, '/dev/ttyACM0');
    assert.strictEqual(ports[0].serialNumber, '389434743434');
    assert.strictEqual(stablePortTarget(ports[0]), 'id:389434743434');
    assert.match(describePort(ports[0]), /f055:9800/);
    assert.strictEqual(ports[1].path, '/dev/ttyS0');
    assert.strictEqual(ports.length, 2);
  });

  test('preserves spaces in device file names', () => {
    assert.deepStrictEqual(
      parseFileSystemEntry('1234 web app config.json'),
      { name: 'web app config.json', isDirectory: false }
    );
    assert.deepStrictEqual(
      parseFileSystemEntry('0 assets folder/'),
      { name: 'assets folder', isDirectory: true }
    );
  });

  test('decodes the MicroPython ABI reported by the connected board', () => {
    assert.deepStrictEqual(decodeMpyAbi(7942), {
      bytecodeVersion: 6.3,
      architectureCode: 7
    });
    assert.deepStrictEqual(decodeMpyAbi(0), {});
  });

  test('passes command arguments without a shell', async () => {
    const dangerousArgument = 'value; echo SHOULD_NOT_RUN';
    const result = await runProcess({
      executable: process.execPath,
      prefixArgs: ['-e', 'process.stdout.write(process.argv[1])'],
      source: 'configured'
    }, [dangerousArgument]);
    assert.strictEqual(result.stdout, dangerousArgument);
  });

  test('reports process timeouts explicitly instead of losing the root cause', async () => {
    await assert.rejects(
      runProcess(
        { executable: process.execPath, prefixArgs: [], source: 'configured' },
        ['-e', 'setTimeout(() => {}, 1000)'],
        { timeoutMs: 25 }
      ),
      (error: unknown) => error instanceof ProcessExecutionError
        && error.timedOut
        && /timed out after 1 seconds/u.test(error.message)
    );
  });

  test('batches log lines into one Output update and never loses a pending block', () => {
    const blocks: string[] = [];
    const scheduled: Array<() => void> = [];
    const cancelled: unknown[] = [];
    const writer = new BufferedTextWriter(
      (text) => blocks.push(text),
      150,
      64 * 1024,
      (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      (handle) => cancelled.push(handle)
    );

    writer.appendLine('first');
    writer.appendLine('second');
    assert.strictEqual(scheduled.length, 1);
    assert.deepStrictEqual(blocks, []);

    scheduled[0]();
    assert.deepStrictEqual(blocks, ['first\nsecond\n']);

    writer.append('tail');
    writer.dispose();
    assert.deepStrictEqual(blocks, ['first\nsecond\n', 'tail']);
    assert.ok(cancelled.length >= 1);
  });

  test('flushes a log batch immediately when its bounded buffer is full', () => {
    const blocks: string[] = [];
    const writer = new BufferedTextWriter(
      (text) => blocks.push(text),
      150,
      8,
      () => 1,
      () => undefined
    );
    writer.append('1234');
    writer.append('5678');
    assert.deepStrictEqual(blocks, ['12345678']);
  });

  test('interrupts a running board before submitting startup commands to its REPL', async () => {
    const events: string[] = [];
    await runReplCommands(
      {
        sendText(text, shouldExecute) {
          events.push(`send:${JSON.stringify(text)}:${String(shouldExecute)}`);
        }
      },
      ['print("ready")', 'help()'],
      async (milliseconds) => {
        events.push(`wait:${milliseconds}`);
      }
    );
    assert.deepStrictEqual(events, [
      'wait:1500',
      'send:"\\u0003":false',
      'wait:300',
      'send:"print(\\"ready\\")":true',
      'wait:200',
      'send:"help()":true'
    ]);
  });

  test('soft-resets through the friendly REPL so MicroPython runs main.py itself', async () => {
    const events: string[] = [];
    await restartMicroPythonInRepl(
      {
        sendText(text, shouldExecute) {
          events.push(`send:${JSON.stringify(text)}:${String(shouldExecute)}`);
        }
      },
      [],
      async (milliseconds) => {
        events.push(`wait:${milliseconds}`);
      }
    );
    assert.deepStrictEqual(events, [
      'wait:1500',
      'send:"\\u0003":false',
      'wait:300',
      'send:"\\u0004":false'
    ]);
  });

  test('imports a precompiled-only main.mpy after the standard soft reset', async () => {
    const events: string[] = [];
    await restartMicroPythonInRepl(
      {
        sendText(text, shouldExecute) {
          events.push(`send:${JSON.stringify(text)}:${String(shouldExecute)}`);
        }
      },
      ['import main'],
      async (milliseconds) => {
        events.push(`wait:${milliseconds}`);
      }
    );
    assert.deepStrictEqual(events, [
      'wait:1500',
      'send:"\\u0003":false',
      'wait:300',
      'send:"\\u0004":false',
      'wait:1500',
      'send:"import main":true',
      'wait:200'
    ]);
  });

  test('resolves the project containing the active file before workspace order', () => {
    const first = { value: 'first', rootPath: path.join(os.tmpdir(), 'first'), hasSourceDirectory: true };
    const active = { value: 'active', rootPath: path.join(os.tmpdir(), 'active'), hasSourceDirectory: true };
    const resolution = resolveProjectCandidate(
      [first, active],
      path.join(active.rootPath, 'src', 'main.py')
    );
    assert.strictEqual(resolution.selected?.value, 'active');
    assert.deepStrictEqual(resolution.choices, []);
  });

  test('requires an explicit choice when multiple MPyTools projects are ambiguous', () => {
    const candidates = [
      { value: 'first', rootPath: path.join(os.tmpdir(), 'first'), hasSourceDirectory: true },
      { value: 'second', rootPath: path.join(os.tmpdir(), 'second'), hasSourceDirectory: true },
      { value: 'not-a-project', rootPath: path.join(os.tmpdir(), 'third'), hasSourceDirectory: false }
    ];
    const resolution = resolveProjectCandidate(candidates);
    assert.strictEqual(resolution.selected, undefined);
    assert.deepStrictEqual(resolution.choices.map((candidate) => candidate.value), ['first', 'second']);
  });

  test('accepts exactly one generic main.py or main.mpy entry point', () => {
    assert.strictEqual(resolveProjectEntryPoint(true, false), 'python');
    assert.strictEqual(resolveProjectEntryPoint(false, true), 'bytecode');
    assert.strictEqual(conflictingProjectEntryPoint('python'), 'main.mpy');
    assert.strictEqual(conflictingProjectEntryPoint('bytecode'), 'main.py');
    assert.throws(() => resolveProjectEntryPoint(true, true), /exactly one/u);
    assert.throws(() => resolveProjectEntryPoint(false, false), /not found/u);
  });

  test('preserves root boot.py and main.py for the standard MicroPython boot sequence', () => {
    const sourceRoot = path.join(os.tmpdir(), 'startup-source');
    assert.strictEqual(isRootStartupPythonFile(sourceRoot, path.join(sourceRoot, 'boot.py')), true);
    assert.strictEqual(isRootStartupPythonFile(sourceRoot, path.join(sourceRoot, 'main.py')), true);
    assert.strictEqual(isRootStartupPythonFile(sourceRoot, path.join(sourceRoot, 'lib', 'main.py')), false);
    assert.strictEqual(isRootStartupPythonFile(sourceRoot, path.join(sourceRoot, 'worker.py')), false);
  });

  test('scales serial upload timeouts with payload size and file count', () => {
    assert.strictEqual(estimateUploadTimeoutMs(0, 0), 120_000);
    const projectTimeout = estimateUploadTimeoutMs(406_424, 90);
    assert.ok(projectTimeout > 8 * 60_000);
    assert.ok(projectTimeout <= 15 * 60_000);
    assert.strictEqual(estimateUploadTimeoutMs(Number.POSITIVE_INFINITY, -1), 120_000);
  });

  test('defaults to visible mpy output and isolates protected project caches', () => {
    const workspaceA = path.join(os.tmpdir(), 'project-a');
    const workspaceB = path.join(os.tmpdir(), 'project-b');
    const globalStorage = path.join(os.tmpdir(), 'mpytools-global-storage');
    const defaultVisible = resolveBuildStoragePaths(workspaceA, undefined, globalStorage);
    assert.strictEqual(defaultVisible.build, path.join(workspaceA, 'mpy'));

    const first = resolveBuildStoragePaths(workspaceA, undefined, globalStorage, 'extensionStorage');
    const second = resolveBuildStoragePaths(workspaceB, undefined, globalStorage, 'extensionStorage');

    assert.strictEqual(isPathInside(workspaceA, first.root), false);
    assert.notStrictEqual(first.root, second.root);
    assert.strictEqual(first.build, path.join(first.root, 'build'));
    assert.strictEqual(first.wrappers, path.join(first.root, 'wrappers'));
    const sharedWorkspaceStorage = path.join(os.tmpdir(), 'vscode-workspace-storage');
    const multiRootFirst = resolveBuildStoragePaths(
      workspaceA,
      sharedWorkspaceStorage,
      globalStorage,
      'extensionStorage'
    );
    const multiRootSecond = resolveBuildStoragePaths(
      workspaceB,
      sharedWorkspaceStorage,
      globalStorage,
      'extensionStorage'
    );
    assert.notStrictEqual(multiRootFirst.root, multiRootSecond.root);

    const visible = resolveBuildStoragePaths(
      workspaceA,
      sharedWorkspaceStorage,
      globalStorage,
      'workspace'
    );
    assert.strictEqual(visible.build, path.join(workspaceA, 'mpy'));
    assert.strictEqual(isPathInside(workspaceA, visible.root), false);
    assert.throws(() => resolveBuildStoragePaths(
      workspaceA,
      path.join(workspaceA, '.extension-storage'),
      globalStorage
    ), /unsafe build storage path/);
  });

  test('clears only resolved MPyTools cache paths in visible workspace mode', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mpytools-visible-build-'));
    try {
      const workspaceRoot = path.join(temporaryRoot, 'project');
      const globalStorage = path.join(temporaryRoot, 'global-storage');
      const unrelated = path.join(workspaceRoot, 'keep.txt');
      const storage = resolveBuildStoragePaths(workspaceRoot, undefined, globalStorage, 'workspace');
      fs.mkdirSync(storage.root, { recursive: true });
      fs.mkdirSync(storage.build, { recursive: true });
      fs.writeFileSync(path.join(storage.root, 'build-config.json'), '{}');
      fs.writeFileSync(path.join(storage.build, 'main.mpy'), 'compiled');
      fs.writeFileSync(unrelated, 'keep');

      await clearBuildStorage(storage);

      assert.strictEqual(fs.existsSync(storage.root), false);
      assert.strictEqual(fs.existsSync(storage.build), false);
      assert.strictEqual(fs.readFileSync(unrelated, 'utf-8'), 'keep');
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('ignores generated Python caches and classifies only configured assets for wrapping', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mpytools-inventory-'));
    try {
      const sourceRoot = path.join(temporaryRoot, 'src');
      fs.mkdirSync(path.join(sourceRoot, '__pycache__'), { recursive: true });
      fs.mkdirSync(path.join(sourceRoot, '.hidden'), { recursive: true });
      fs.mkdirSync(path.join(sourceRoot, 'web'), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, 'main.py'), 'print(1)\n');
      fs.writeFileSync(path.join(sourceRoot, '__pycache__', 'main.cpython-314.pyc'), 'cache');
      fs.writeFileSync(path.join(sourceRoot, '.hidden', 'secret.py'), 'secret = True\n');
      fs.writeFileSync(path.join(sourceRoot, 'web', 'page.html'), '<h1>Hello</h1>');
      fs.writeFileSync(path.join(sourceRoot, 'settings.JSON'), '{}');
      fs.writeFileSync(path.join(sourceRoot, 'firmware.bin'), Buffer.from([0, 1, 2]));

      const inventory = await collectSourceInventory(sourceRoot, ['html', '.json']);
      assert.deepStrictEqual(inventory.pythonFiles.map((file) => path.basename(file)), ['main.py']);
      assert.deepStrictEqual(
        inventory.wrappableAssetFiles.map((file) => path.basename(file)),
        ['settings.JSON', 'page.html']
      );
      assert.deepStrictEqual(inventory.rawAssetFiles.map((file) => path.basename(file)), ['firmware.bin']);
      assert.ok(inventory.ignoredEntries.some((entry) => entry.endsWith('__pycache__')));
      assert.ok(inventory.ignoredEntries.some((entry) => entry.endsWith('.hidden')));
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('rejects build output collisions instead of silently overwriting an asset', () => {
    const output = path.join(os.tmpdir(), 'mpytools-build', 'page.mpy');
    assert.throws(() => assertUniqueOutputPaths([output, output]), /same build output/);
  });

  test('creates portable archives and never replaces an existing destination', async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mpytools-archive-test-'));
    try {
      const source = path.join(temporaryRoot, 'source');
      const archive = path.join(temporaryRoot, 'project.zip');
      fs.mkdirSync(path.join(source, 'assets folder'), { recursive: true });
      fs.writeFileSync(path.join(source, 'assets folder', 'hello world.txt'), 'hello');
      await createZipArchive(source, archive);
      const bytes = fs.readFileSync(archive);
      assert.strictEqual(bytes.subarray(0, 2).toString('ascii'), 'PK');
      assert.ok(bytes.includes(Buffer.from('src/assets folder/hello world.txt')));

      const protectedArchive = path.join(temporaryRoot, 'existing.zip');
      fs.writeFileSync(protectedArchive, 'do-not-delete');
      await assert.rejects(createZipArchive(source, protectedArchive));
      assert.strictEqual(fs.readFileSync(protectedArchive, 'utf8'), 'do-not-delete');
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
