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
import { runProcess } from '../processRunner';
import { runReplCommands } from '../replControl';
import {
  assertUniqueOutputPaths,
  collectSourceInventory,
  isPathInside,
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
      ['import main', 'main.run()'],
      async (milliseconds) => {
        events.push(`wait:${milliseconds}`);
      }
    );
    assert.deepStrictEqual(events, [
      'wait:1500',
      'send:"\\u0003":false',
      'wait:300',
      'send:"import main":true',
      'wait:200',
      'send:"main.run()":true'
    ]);
  });

  test('keeps build artifacts outside the workspace and isolates project caches', () => {
    const workspaceA = path.join(os.tmpdir(), 'project-a');
    const workspaceB = path.join(os.tmpdir(), 'project-b');
    const globalStorage = path.join(os.tmpdir(), 'mpytools-global-storage');
    const first = resolveBuildStoragePaths(workspaceA, undefined, globalStorage);
    const second = resolveBuildStoragePaths(workspaceB, undefined, globalStorage);

    assert.strictEqual(isPathInside(workspaceA, first.root), false);
    assert.notStrictEqual(first.root, second.root);
    assert.strictEqual(first.build, path.join(first.root, 'build'));
    assert.strictEqual(first.wrappers, path.join(first.root, 'wrappers'));
    assert.throws(() => resolveBuildStoragePaths(
      workspaceA,
      path.join(workspaceA, '.extension-storage'),
      globalStorage
    ), /unsafe build storage path/);
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
