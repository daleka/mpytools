import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const BUILD_CACHE_SCHEMA = 'build-cache-v2';

export const DEFAULT_WRAPPABLE_ASSET_EXTENSIONS = [
  '.cfg',
  '.css',
  '.csv',
  '.htm',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.md',
  '.svg',
  '.toml',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
] as const;

const IGNORED_DIRECTORY_NAMES = new Set([
  '__pycache__',
  '.git',
  '.hg',
  '.mypy_cache',
  '.mpytools',
  '.pytest_cache',
  '.ruff_cache',
  '.svn',
  '.tox',
  '.venv',
  'node_modules',
  'venv'
]);

const IGNORED_FILE_NAMES = new Set([
  '.DS_Store',
  'desktop.ini',
  'Thumbs.db'
]);

const IGNORED_GENERATED_EXTENSIONS = new Set([
  '.pyc',
  '.pyd',
  '.pyo'
]);

export interface BuildStoragePaths {
  root: string;
  build: string;
  wrappers: string;
}

export interface SourceInventory {
  pythonFiles: string[];
  wrappableAssetFiles: string[];
  rawAssetFiles: string[];
  ignoredEntries: string[];
}

function normalizedPathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Uses VS Code's workspace-scoped extension storage. The global fallback is
 * namespaced by a stable workspace hash so two projects can never share output.
 */
export function resolveBuildStoragePaths(
  workspaceRoot: string,
  workspaceStoragePath: string | undefined,
  globalStoragePath: string
): BuildStoragePaths {
  const workspaceHash = createHash('sha256')
    .update(normalizedPathKey(workspaceRoot))
    .digest('hex')
    .slice(0, 20);
  const storageBase = workspaceStoragePath
    ? path.resolve(workspaceStoragePath)
    : path.join(path.resolve(globalStoragePath), 'workspaces', workspaceHash);
  const root = path.join(storageBase, BUILD_CACHE_SCHEMA);

  if (normalizedPathKey(root) === normalizedPathKey(workspaceRoot) || isPathInside(workspaceRoot, root)) {
    throw new Error(`VS Code returned an unsafe build storage path inside the workspace: ${root}`);
  }

  return {
    root,
    build: path.join(root, 'build'),
    wrappers: path.join(root, 'wrappers')
  };
}

export function normalizeAssetExtensions(extensions: readonly string[]): Set<string> {
  return new Set(extensions.map((extension) => {
    const trimmed = extension.trim().toLowerCase();
    return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  }).filter((extension) => extension.length > 1));
}

function shouldIgnoreDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(name);
}

function shouldIgnoreFile(name: string): boolean {
  return name.startsWith('.')
    || IGNORED_FILE_NAMES.has(name)
    || IGNORED_GENERATED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Enumerates only real source files and never follows symlinks. */
export async function collectSourceInventory(
  sourceRoot: string,
  wrappableExtensions: readonly string[] = DEFAULT_WRAPPABLE_ASSET_EXTENSIONS
): Promise<SourceInventory> {
  const pythonFiles: string[] = [];
  const wrappableAssetFiles: string[] = [];
  const rawAssetFiles: string[] = [];
  const ignoredEntries: string[] = [];
  const wrappable = normalizeAssetExtensions(wrappableExtensions);

  async function visit(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        ignoredEntries.push(entryPath);
      } else if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(entry.name)) {
          ignoredEntries.push(entryPath);
        } else {
          await visit(entryPath);
        }
      } else if (entry.isFile()) {
        if (shouldIgnoreFile(entry.name)) {
          ignoredEntries.push(entryPath);
          continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (extension === '.py') {
          pythonFiles.push(entryPath);
        } else if (wrappable.has(extension)) {
          wrappableAssetFiles.push(entryPath);
        } else {
          rawAssetFiles.push(entryPath);
        }
      }
    }
  }

  await visit(sourceRoot);
  return { pythonFiles, wrappableAssetFiles, rawAssetFiles, ignoredEntries };
}

export function assertUniqueOutputPaths(outputPaths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const outputPath of outputPaths) {
    const key = normalizedPathKey(outputPath);
    const previous = seen.get(key);
    if (previous) {
      throw new Error(`Two source files map to the same build output: ${previous} and ${outputPath}`);
    }
    seen.set(key, outputPath);
  }
}

export async function ensureParentDirectories(filePaths: Iterable<string>): Promise<void> {
  const directories = new Set([...filePaths].map((filePath) => path.dirname(filePath)));
  await Promise.all([...directories].map((directory) => fs.promises.mkdir(directory, { recursive: true })));
}
