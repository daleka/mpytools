import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

interface VersioningConfig {
  enabled?: boolean;
  generator?: string;
  output?: string;
  pythonCommand?: string;
  autoSnapshot?: boolean;
  snapshotDirectory?: string;
}

interface ProjectConfig {
  versioning?: VersioningConfig;
}

export interface PreparedFirmwareVersion {
  version: string;
  versionFilePath: string;
  snapshotDirectory: string;
  autoSnapshot: boolean;
}

export interface SnapshotResult {
  path: string;
  created: boolean;
}

const PROJECT_CONFIG_NAME = '.mpytools.json';

function resolveInsideWorkspace(workspaceRoot: string, configuredPath: string, label: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, configuredPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the workspace: ${configuredPath}`);
  }
  return resolved;
}

function readProjectConfig(workspaceRoot: string): ProjectConfig | undefined {
  const configPath = path.join(workspaceRoot, PROJECT_CONFIG_NAME);
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ProjectConfig;
  } catch (error: any) {
    throw new Error(`Cannot read ${PROJECT_CONFIG_NAME}: ${error.message}`);
  }
}

function execFilePromise(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(details));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function readFirmwareVersion(versionFilePath: string): string {
  const content = fs.readFileSync(versionFilePath, 'utf-8');
  const match = content.match(/^FW_VERSION\s*=\s*(['"])([^'"]+)\1\s*$/m);
  if (!match || !match[2] || match[2] === 'UNBUILT') {
    throw new Error(`Generated file does not contain a usable FW_VERSION: ${versionFilePath}`);
  }
  return match[2];
}

export async function prepareFirmwareVersion(
  workspaceRoot: string,
  outputChannel: vscode.OutputChannel
): Promise<PreparedFirmwareVersion | undefined> {
  const config = readProjectConfig(workspaceRoot);
  const versioning = config?.versioning;
  if (!versioning?.enabled) {
    return undefined;
  }
  if (!vscode.workspace.isTrusted) {
    throw new Error('Version generation requires a trusted VS Code workspace.');
  }

  const generatorSetting = versioning.generator ?? 'tools/generate_fw_version.py';
  const outputSetting = versioning.output ?? 'src/generated/fw_version.py';
  const snapshotSetting = versioning.snapshotDirectory ?? '.save/mpytools-builds';
  const generatorPath = resolveInsideWorkspace(workspaceRoot, generatorSetting, 'Version generator');
  const versionFilePath = resolveInsideWorkspace(workspaceRoot, outputSetting, 'Version output');
  const snapshotDirectory = resolveInsideWorkspace(workspaceRoot, snapshotSetting, 'Snapshot directory');
  if (!fs.existsSync(generatorPath)) {
    throw new Error(`Version generator not found: ${generatorSetting}`);
  }

  const pythonCommand = versioning.pythonCommand ?? (os.platform() === 'win32' ? 'python' : 'python3');
  outputChannel.appendLine(`🔖 Generating firmware version: ${generatorSetting}`);
  const result = await execFilePromise(
    pythonCommand,
    [generatorPath, '--output', outputSetting],
    workspaceRoot
  );
  if (result.stdout.trim()) {
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      outputChannel.appendLine(`   ${line}`);
    }
  }
  if (result.stderr.trim()) {
    for (const line of result.stderr.trim().split(/\r?\n/)) {
      outputChannel.appendLine(`   ⚠️ ${line}`);
    }
  }

  if (!fs.existsSync(versionFilePath)) {
    throw new Error(`Version generator did not create: ${outputSetting}`);
  }
  const version = readFirmwareVersion(versionFilePath);
  outputChannel.appendLine(`   ✅ Firmware version: ${version}`);

  return {
    version,
    versionFilePath,
    snapshotDirectory,
    autoSnapshot: versioning.autoSnapshot !== false
  };
}

function safeSnapshotName(version: string): string {
  return version.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

export function saveFirmwareSnapshot(
  workspaceRoot: string,
  prepared: PreparedFirmwareVersion
): SnapshotResult | undefined {
  if (!prepared.autoSnapshot) {
    return undefined;
  }

  const sourcePath = path.join(workspaceRoot, 'src');
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source directory not found: ${sourcePath}`);
  }
  const sourceToSnapshot = path.relative(sourcePath, prepared.snapshotDirectory);
  if (!sourceToSnapshot.startsWith('..') && !path.isAbsolute(sourceToSnapshot)) {
    throw new Error('Snapshot directory cannot be inside src.');
  }

  const snapshotPath = path.join(prepared.snapshotDirectory, safeSnapshotName(prepared.version));
  if (fs.existsSync(snapshotPath)) {
    return { path: snapshotPath, created: false };
  }

  fs.mkdirSync(prepared.snapshotDirectory, { recursive: true });
  const temporaryPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(temporaryPath, { recursive: true });
    fs.cpSync(sourcePath, path.join(temporaryPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(temporaryPath, 'build-info.json'),
      JSON.stringify({
        version: prepared.version,
        createdAtUtc: new Date().toISOString()
      }, null, 2) + '\n',
      'utf-8'
    );
    fs.renameSync(temporaryPath, snapshotPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { recursive: true, force: true });
    }
    throw error;
  }

  return { path: snapshotPath, created: true };
}
