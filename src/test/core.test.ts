import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createZipArchive } from '../archive';
import { decodeMpyAbi } from '../micropythonInfo';
import { parseFileSystemEntry } from '../deviceFiles';
import {
  describePort,
  normalizePortTarget,
  parseMpremotePortList,
  stablePortTarget
} from '../ports';
import { runProcess } from '../processRunner';

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
