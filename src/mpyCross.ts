import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const EXEC_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type MpyCrossTargetMode = 'native' | 'launcher';

export interface MpyCrossTarget {
  executable: string;
  prefixArgs: string[];
  mode: MpyCrossTargetMode;
  versionText: string;
  bytecodeVersion?: string;
  packageRoot?: string;
}

export interface MpyCrossRunResult {
  target: MpyCrossTarget;
  args: string[];
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

interface NativeProbe {
  executable: string;
  versionText: string;
  bytecodeVersion?: string;
}

const targetCache = new Map<string, Promise<MpyCrossTarget>>();
let launcherHints: string[] = [];

function execFilePromise(
  executable: string,
  args: string[],
  cwd?: string
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        windowsHide: true,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        const standardOutput = stdout?.toString() ?? '';
        const standardError = stderr?.toString() ?? '';
        if (error) {
          const details = standardError.trim() || standardOutput.trim();
          reject(new Error(details ? `${error.message}\n${details}` : error.message));
          return;
        }
        resolve({ stdout: standardOutput, stderr: standardError });
      }
    );
  });
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function uniqueExistingDirectories(paths: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    let resolved = path.resolve(candidate);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // Keep the absolute path so a missing candidate is simply ignored below.
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key) && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      seen.add(key);
      result.push(resolved);
    }
  }
  return result;
}

function stripPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Finds a command exactly as the current process PATH would resolve it. */
export function findExecutableOnPath(
  command: string,
  pathValue: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
  pathExtValue: string = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
): string | undefined {
  if (path.isAbsolute(command) && isFile(command)) {
    return path.resolve(command);
  }

  const hasExtension = path.extname(command).length > 0;
  const extensions = platform === 'win32' && !hasExtension
    ? pathExtValue.split(';').filter(Boolean)
    : [''];

  for (const rawDirectory of pathValue.split(path.delimiter)) {
    const directory = stripPathQuotes(rawDirectory) || process.cwd();
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isFile(candidate)) {
        try {
          return fs.realpathSync.native(candidate);
        } catch {
          return path.resolve(candidate);
        }
      }
    }
  }
  return undefined;
}

function packageRootsUnderEnvironment(environmentRoot: string): string[] {
  const candidates = [
    path.join(environmentRoot, 'Lib', 'site-packages', 'mpy_cross'),
    path.join(environmentRoot, 'lib', 'site-packages', 'mpy_cross'),
    path.join(environmentRoot, 'site-packages', 'mpy_cross')
  ];

  const libDirectory = path.join(environmentRoot, 'lib');
  if (fs.existsSync(libDirectory)) {
    try {
      for (const entry of fs.readdirSync(libDirectory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidates.push(path.join(libDirectory, entry.name, 'site-packages', 'mpy_cross'));
        }
      }
    } catch {
      // A protected lib directory is not fatal; other discovery methods remain available.
    }
  }
  return candidates;
}

/**
 * Locates the pip package belonging to a Scripts/bin console launcher.
 * Supports system Python, venv, pip --user and pipx layouts.
 */
export function findMpyCrossPackageRootsNearLauncher(launcherPath: string): string[] {
  let realLauncher = path.resolve(launcherPath);
  try {
    realLauncher = fs.realpathSync.native(realLauncher);
  } catch {
    // The caller will fall back to the launcher if it disappears.
  }

  const launcherDirectory = path.dirname(realLauncher);
  const directParent = path.basename(launcherDirectory).toLowerCase() === 'mpy_cross'
    ? launcherDirectory
    : undefined;
  const environmentRoot = path.dirname(launcherDirectory);
  const candidates = directParent ? [directParent] : [];
  candidates.push(...packageRootsUnderEnvironment(environmentRoot));
  return uniqueExistingDirectories(candidates);
}

function nativeNames(): string[] {
  return process.platform === 'win32'
    ? ['mpy-cross.exe', 'mpy-cross']
    : ['mpy-cross', 'mpy-cross.exe'];
}

function findNativeInDirectory(directory: string): string | undefined {
  for (const fileName of nativeNames()) {
    const candidate = path.join(directory, fileName);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Returns the package's current binary first, followed by archived compatibility binaries. */
export function listNativeMpyCrossCandidates(packageRoot: string): string[] {
  const candidates: string[] = [];
  const current = findNativeInDirectory(packageRoot);
  if (current) {
    candidates.push(current);
  }

  const archiveRoot = path.join(packageRoot, 'archive');
  if (fs.existsSync(archiveRoot)) {
    try {
      const versions = fs.readdirSync(archiveRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      for (const version of versions) {
        const archived = findNativeInDirectory(path.join(archiveRoot, version));
        if (archived) {
          candidates.push(archived);
        }
      }
    } catch {
      // The current binary or launcher fallback can still be used.
    }
  }
  return candidates;
}

/** Mirrors the bytecode-to-archive lookup shipped by the installed mpy_cross package. */
export function findMpyCrossArchiveVersion(
  packageRoot: string,
  bytecodeVersion: number | string
): string | undefined {
  const requested = normalizeBytecodeVersion(bytecodeVersion);
  if (!requested) {
    return undefined;
  }
  const versionsFile = path.join(packageRoot, 'versions.py');
  try {
    const source = fs.readFileSync(versionsFile, 'utf-8');
    const tuplePattern = /\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = tuplePattern.exec(source)) !== null) {
      if (normalizeBytecodeVersion(match[2]) === requested) {
        return match[1];
      }
    }
  } catch {
    // The launcher fallback owns compatibility selection when metadata is unavailable.
  }
  return undefined;
}

export function parseMpyCrossBytecodeVersion(versionText: string): string | undefined {
  return versionText.match(/\bmpy\s+v(\d+(?:\.\d+)*)\b/i)?.[1];
}

function normalizeBytecodeVersion(version: number | string | undefined): string | undefined {
  if (version === undefined || version === '') {
    return undefined;
  }
  const numeric = Number(version);
  return Number.isFinite(numeric) ? String(numeric) : String(version).trim();
}

async function probeNative(executable: string): Promise<NativeProbe | undefined> {
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(executable).mode;
      fs.chmodSync(executable, mode | 0o111);
    } catch {
      // execFile will provide the useful error if permissions cannot be fixed.
    }
  }
  try {
    const result = await execFilePromise(executable, ['--version']);
    const versionText = `${result.stdout}\n${result.stderr}`.trim();
    return {
      executable,
      versionText,
      bytecodeVersion: parseMpyCrossBytecodeVersion(versionText)
    };
  } catch {
    return undefined;
  }
}

async function selectNativeTarget(
  packageRoot: string,
  requestedBytecode: string | undefined
): Promise<MpyCrossTarget | undefined> {
  let executable: string | undefined;
  if (requestedBytecode === undefined) {
    executable = findNativeInDirectory(packageRoot);
  } else {
    const archiveVersion = findMpyCrossArchiveVersion(packageRoot, requestedBytecode);
    if (archiveVersion) {
      executable = findNativeInDirectory(path.join(packageRoot, 'archive', archiveVersion));
    }
  }
  if (!executable) {
    return undefined;
  }

  const probe = await probeNative(executable);
  if (!probe || (requestedBytecode !== undefined && probe.bytecodeVersion !== requestedBytecode)) {
    return undefined;
  }
  return {
    executable: probe.executable,
    prefixArgs: [],
    mode: 'native',
    versionText: probe.versionText,
    bytecodeVersion: probe.bytecodeVersion,
    packageRoot
  };
}

interface PythonCommand {
  executable: string;
  prefixArgs: string[];
}

function pythonCommands(): PythonCommand[] {
  const definitions = process.platform === 'win32'
    ? [
        { name: 'python', prefixArgs: [] },
        { name: 'py', prefixArgs: ['-3'] },
        { name: 'python3', prefixArgs: [] }
      ]
    : [
        { name: 'python3', prefixArgs: [] },
        { name: 'python', prefixArgs: [] }
      ];
  const result: PythonCommand[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const executable = findExecutableOnPath(definition.name);
    if (!executable) {
      continue;
    }
    const key = `${executable.toLowerCase()}\0${definition.prefixArgs.join('\0')}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ executable, prefixArgs: definition.prefixArgs });
    }
  }
  return result;
}

async function packageRootsFromPython(): Promise<string[]> {
  const roots: string[] = [];
  const script = [
    'from pathlib import Path',
    'import mpy_cross',
    'print(Path(mpy_cross.__file__).resolve().parent)'
  ].join('; ');

  for (const command of pythonCommands()) {
    try {
      const result = await execFilePromise(
        command.executable,
        [...command.prefixArgs, '-c', script]
      );
      const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines.reverse()) {
        if (fs.existsSync(line) && fs.statSync(line).isDirectory()) {
          roots.push(line);
          break;
        }
      }
    } catch {
      // Try the next installed Python runtime.
    }
  }
  return uniqueExistingDirectories(roots);
}

async function probeLauncher(
  executable: string,
  requestedBytecode: string | undefined
): Promise<MpyCrossTarget> {
  const prefixArgs = requestedBytecode ? ['-b', requestedBytecode] : [];
  const result = await execFilePromise(executable, [...prefixArgs, '--version']);
  const versionText = `${result.stdout}\n${result.stderr}`.trim();
  return {
    executable,
    prefixArgs,
    mode: 'launcher',
    versionText,
    bytecodeVersion: parseMpyCrossBytecodeVersion(versionText)
  };
}

async function resolveMpyCrossTargetUncached(
  bytecodeVersion: number | string | undefined
): Promise<MpyCrossTarget> {
  const requestedBytecode = normalizeBytecodeVersion(bytecodeVersion);
  const pathLauncher = findExecutableOnPath('mpy-cross');
  const launchers = [...launcherHints, ...(pathLauncher ? [pathLauncher] : [])]
    .filter((candidate, index, values) => isFile(candidate) && values.indexOf(candidate) === index);
  const nearbyRoots = uniqueExistingDirectories(
    launchers.flatMap((launcher) => findMpyCrossPackageRootsNearLauncher(launcher))
  );

  for (const packageRoot of nearbyRoots) {
    const target = await selectNativeTarget(packageRoot, requestedBytecode);
    if (target) {
      return target;
    }
  }

  const pythonRoots = await packageRootsFromPython();
  for (const packageRoot of pythonRoots) {
    if (nearbyRoots.includes(packageRoot)) {
      continue;
    }
    const target = await selectNativeTarget(packageRoot, requestedBytecode);
    if (target) {
      return target;
    }
  }

  for (const launcher of launchers) {
    try {
      return await probeLauncher(launcher, requestedBytecode);
    } catch {
      // Try the next configured/system launcher.
    }
  }

  throw new Error(
    'mpy-cross is not available. Run “MPYTools: Install Dependencies” and try again.'
  );
}

export function resolveMpyCrossTarget(
  bytecodeVersion?: number | string
): Promise<MpyCrossTarget> {
  const cacheKey = normalizeBytecodeVersion(bytecodeVersion) ?? 'current';
  const cached = targetCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resolving = resolveMpyCrossTargetUncached(bytecodeVersion).catch((error) => {
    targetCache.delete(cacheKey);
    throw error;
  });
  targetCache.set(cacheKey, resolving);
  return resolving;
}

export async function runMpyCross(
  args: string[],
  bytecodeVersion?: number | string,
  cwd?: string
): Promise<MpyCrossRunResult> {
  const target = await resolveMpyCrossTarget(bytecodeVersion);
  const invocationArgs = [...target.prefixArgs, ...args];
  const startedAt = process.hrtime.bigint();
  const result = await execFilePromise(target.executable, invocationArgs, cwd);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return {
    target,
    args: invocationArgs,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs
  };
}

function quoteCommandArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/u.test(argument)) {
    return argument;
  }
  return `"${argument.replace(/([\\]*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function formatMpyCrossInvocation(result: MpyCrossRunResult): string {
  return [result.target.executable, ...result.args].map(quoteCommandArgument).join(' ');
}

/** Test helper; also lets dependency installation recover without reloading VS Code. */
export function resetMpyCrossResolver(): void {
  targetCache.clear();
}

/** Prefer extension-owned launchers without mutating the process-wide PATH. */
export function setMpyCrossLauncherHints(hints: string[]): void {
  launcherHints = [...hints];
  resetMpyCrossResolver();
}
