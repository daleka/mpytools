import * as path from 'path';

export interface SerialPortDescriptor {
  path: string;
  serialNumber?: string;
  vidPid?: string;
  description?: string;
}

const MPREMOTE_TARGET_PREFIX = /^(?:auto|id:|port:)/i;

/**
 * Normalise only user-entered shorthand. Paths returned by mpremote are already
 * complete and must remain idempotent (notably /dev/ttyACM0 on Linux).
 */
export function normalizePortTarget(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const target = value.trim();
  if (!target || MPREMOTE_TARGET_PREFIX.test(target)) {
    return target || 'auto';
  }
  if (platform === 'win32') {
    return path.win32.normalize(target);
  }
  if (path.posix.isAbsolute(target)) {
    return path.posix.normalize(target);
  }
  if ((platform === 'linux' || platform === 'darwin') && !target.includes('/')) {
    return path.posix.join('/dev', target);
  }
  return target;
}

export function stablePortTarget(port: SerialPortDescriptor): string {
  return port.serialNumber ? `id:${port.serialNumber}` : normalizePortTarget(port.path);
}

/** Parse the human-readable `mpremote connect list` output into typed data. */
export function parseMpremotePortList(output: string): SerialPortDescriptor[] {
  const ports: SerialPortDescriptor[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\S+)(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(.*))?$/);
    if (!match || !isSerialPortPath(match[1])) {
      continue;
    }
    const portPath = normalizePortTarget(match[1]);
    if (seen.has(portPath)) {
      continue;
    }
    seen.add(portPath);
    ports.push({
      path: portPath,
      serialNumber: match[2] && match[2] !== 'None' ? match[2] : undefined,
      vidPid: match[3] && match[3] !== '0000:0000' ? match[3] : undefined,
      description: match[4] && match[4] !== 'None None' ? match[4] : undefined
    });
  }
  return ports.sort((left, right) => portPriority(left) - portPriority(right));
}

function isSerialPortPath(value: string): boolean {
  return value.startsWith('/dev/') || /^COM\d+$/i.test(value);
}

export function isLikelyExternalSerialPort(port: SerialPortDescriptor): boolean {
  return /(?:ttyACM|ttyUSB|rfcomm|cu\.|usbmodem|usbserial)/i.test(port.path)
    || /^COM\d+$/i.test(port.path)
    || Boolean(port.vidPid || port.serialNumber);
}

export function describePort(port: SerialPortDescriptor): string {
  return [port.description, port.vidPid, port.serialNumber]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function portPriority(port: SerialPortDescriptor): number {
  return isLikelyExternalSerialPort(port) ? 0 : 1;
}
