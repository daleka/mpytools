export interface DeviceFileEntry {
  name: string;
  isDirectory: boolean;
}

/** Parse an mpremote `fs ls` row while preserving spaces and Unicode in names. */
export function parseFileSystemEntry(line: string): DeviceFileEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('ls :')) {
    return undefined;
  }
  const match = trimmed.match(/^\d+\s+(.+)$/);
  if (!match) {
    return undefined;
  }
  const isDirectory = match[1].endsWith('/');
  const name = match[1].replace(/\/+$/, '');
  return name ? { name, isDirectory } : undefined;
}
