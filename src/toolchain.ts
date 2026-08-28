import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandTarget, runProcess } from './processRunner';
import { resetMpyCrossResolver, resolveMpyCrossTarget, setMpyCrossLauncherHints } from './mpyCross';

export const MPREMOTE_VERSION = '1.29.0';
export const MPY_CROSS_VERSION = '1.28.0.post2';
const TOOLCHAIN_DIRECTORY = `python-tools-mpremote-${MPREMOTE_VERSION}-mpycross-${MPY_CROSS_VERSION}`;

export class ToolchainManager {
  private cachedMpremote: CommandTarget | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  async resolveMpremote(): Promise<CommandTarget> {
    if (this.cachedMpremote) {
      return this.cachedMpremote;
    }
    const configured = vscode.workspace.getConfiguration('mpytools').get<string>('mpremotePath')?.trim();
    const candidates: CommandTarget[] = [];
    if (configured) {
      candidates.push({ executable: configured, prefixArgs: [], source: 'configured' });
    }
    const managedLauncher = this.managedLauncher('mpremote');
    if (isFile(managedLauncher)) {
      candidates.push({ executable: managedLauncher, prefixArgs: [], source: 'managed' });
    }
    const pathLauncher = findExecutableOnPath('mpremote');
    if (pathLauncher) {
      candidates.push({ executable: pathLauncher, prefixArgs: [], source: 'path' });
    }
    for (const candidate of candidates) {
      if (await probe(candidate, ['--version'])) {
        this.cachedMpremote = candidate;
        this.configureMpyCrossHints();
        return candidate;
      }
    }
    for (const python of pythonCommands()) {
      const candidate: CommandTarget = {
        executable: python.executable,
        prefixArgs: [...python.prefixArgs, '-m', 'mpremote'],
        source: 'python-module'
      };
      if (await probe(candidate, ['--version'])) {
        this.cachedMpremote = candidate;
        this.configureMpyCrossHints();
        return candidate;
      }
    }
    throw new Error('mpremote is not available. Run “MPYTools: Install Managed Toolchain”.');
  }

  async health(): Promise<{ mpremote?: CommandTarget; mpyCrossAvailable: boolean }> {
    let mpremote: CommandTarget | undefined;
    try {
      mpremote = await this.resolveMpremote();
    } catch {
      // Reported by the caller.
    }
    this.configureMpyCrossHints();
    let mpyCrossAvailable = false;
    try {
      await resolveMpyCrossTarget();
      mpyCrossAvailable = true;
    } catch {
      // Reported by the caller.
    }
    return { mpremote, mpyCrossAvailable };
  }

  async installManagedToolchain(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const storageRoot = this.context.globalStorageUri.fsPath;
    const stagingRoot = fs.mkdtempSync(path.join(storageRoot, 'toolchain-install-'));
    const stagedEnvironment = path.join(stagingRoot, 'venv');
    const finalEnvironment = this.managedEnvironmentRoot();
    const previousEnvironment = `${finalEnvironment}.previous-${process.pid}-${Date.now()}`;
    let previousMoved = false;
    try {
      const python = await findUsablePython();
      this.output.appendLine(`🔹 Creating managed environment with ${python.executable}`);
      await runProcess(python, ['-m', 'venv', stagedEnvironment], { timeoutMs: 120_000 });
      const stagedPython: CommandTarget = {
        executable: environmentExecutable(stagedEnvironment, 'python'),
        prefixArgs: [],
        source: 'managed'
      };
      this.output.appendLine(`🔹 Installing mpremote ${MPREMOTE_VERSION} and mpy-cross ${MPY_CROSS_VERSION}`);
      const result = await runProcess(stagedPython, [
        '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
        `mpremote==${MPREMOTE_VERSION}`,
        `mpy-cross==${MPY_CROSS_VERSION}`
      ], { timeoutMs: 300_000 });
      if (result.stdout.trim()) {
        this.output.appendLine(result.stdout.trim());
      }
      if (fs.existsSync(finalEnvironment)) {
        fs.renameSync(finalEnvironment, previousEnvironment);
        previousMoved = true;
      }
      try {
        fs.renameSync(stagedEnvironment, finalEnvironment);
      } catch (error) {
        if (previousMoved && !fs.existsSync(finalEnvironment)) {
          fs.renameSync(previousEnvironment, finalEnvironment);
          previousMoved = false;
        }
        throw error;
      }
      if (previousMoved) {
        previousMoved = false;
        try {
          fs.rmSync(previousEnvironment, { recursive: true, force: true });
        } catch (error: any) {
          this.output.appendLine(`⚠️ Old managed environment could not be removed: ${error.message}`);
        }
      }
      this.reset();
      const target = await this.resolveMpremote();
      this.output.appendLine(`✅ Managed mpremote ready: ${target.executable}`);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      if (previousMoved && fs.existsSync(previousEnvironment) && !fs.existsSync(finalEnvironment)) {
        fs.renameSync(previousEnvironment, finalEnvironment);
      }
    }
  }

  reset(): void {
    this.cachedMpremote = undefined;
    resetMpyCrossResolver();
    this.configureMpyCrossHints();
  }

  managedPython(): string | undefined {
    const candidate = environmentExecutable(this.managedEnvironmentRoot(), 'python');
    return isFile(candidate) ? candidate : undefined;
  }

  private configureMpyCrossHints(): void {
    const hint = this.managedLauncher('mpy-cross');
    setMpyCrossLauncherHints(isFile(hint) ? [hint] : []);
  }

  private managedEnvironmentRoot(): string {
    return path.join(this.context.globalStorageUri.fsPath, TOOLCHAIN_DIRECTORY);
  }

  private managedLauncher(name: 'mpremote' | 'mpy-cross'): string {
    return environmentExecutable(this.managedEnvironmentRoot(), name);
  }
}

export function findExecutableOnPath(
  command: string,
  pathValue: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (path.isAbsolute(command) && isFile(command)) {
    return fs.realpathSync.native(command);
  }
  const extensions = platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of (pathValue ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === 'win32' ? command + extension : command);
      if (isFile(candidate)) {
        return fs.realpathSync.native(candidate);
      }
    }
  }
  return undefined;
}

function environmentExecutable(environmentRoot: string, name: string): string {
  if (process.platform === 'win32') {
    const fileName = name === 'python' ? 'python.exe' : `${name}.exe`;
    return path.join(environmentRoot, 'Scripts', fileName);
  }
  return path.join(environmentRoot, 'bin', name === 'python' ? 'python' : name);
}

function pythonCommands(): CommandTarget[] {
  const names = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  return names.flatMap((name): CommandTarget[] => {
    const executable = findExecutableOnPath(name);
    if (!executable) {
      return [];
    }
    return [{
      executable,
      prefixArgs: name === 'py' ? ['-3'] : [],
      source: 'path'
    }];
  });
}

async function findUsablePython(): Promise<CommandTarget> {
  for (const candidate of pythonCommands()) {
    if (await probe(candidate, ['-c', 'import sys; print(sys.version)'])) {
      return candidate;
    }
  }
  throw new Error('Python 3 is required once to create the managed MPyTools toolchain.');
}

async function probe(target: CommandTarget, args: string[]): Promise<boolean> {
  try {
    await runProcess(target, args, { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
