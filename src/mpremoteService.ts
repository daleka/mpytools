import * as fs from 'fs';
import { formatCommand, ProcessExecutionError, ProcessResult, runProcess } from './processRunner';
import { normalizePortTarget, parseMpremotePortList, SerialPortDescriptor } from './ports';
import { ToolchainManager } from './toolchain';

export type DeviceErrorKind = 'missing' | 'permission' | 'busy' | 'toolchain' | 'command';

export class DeviceCommandError extends Error {
  constructor(
    message: string,
    public readonly kind: DeviceErrorKind,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DeviceCommandError';
  }
}

export class MpremoteService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly toolchain: ToolchainManager,
    private readonly log: (line: string) => void
  ) {}

  async listPorts(): Promise<SerialPortDescriptor[]> {
    const result = await this.run(['connect', 'list'], { timeoutMs: 15_000 });
    return parseMpremotePortList(result.stdout);
  }

  runOnPort(
    port: string,
    args: readonly string[],
    options: { timeoutMs?: number; cwd?: string } = {}
  ): Promise<ProcessResult> {
    const target = normalizePortTarget(port);
    this.assertLocalPortAccessible(target);
    return this.run(['connect', target, ...args], options);
  }

  async run(
    args: readonly string[],
    options: { timeoutMs?: number; cwd?: string } = {}
  ): Promise<ProcessResult> {
    return this.exclusive(async () => {
      let target;
      try {
        target = await this.toolchain.resolveMpremote();
      } catch (error) {
        throw new DeviceCommandError(String(error), 'toolchain', error);
      }
      this.log(`⚙️ ${formatCommand(target, args)}`);
      try {
        const result = await runProcess(target, args, options);
        if (result.stderr.trim()) {
          this.log(`⚠️ ${result.stderr.trim()}`);
        }
        return result;
      } catch (error) {
        throw classifyProcessError(error);
      }
    });
  }

  async terminalInvocation(args: readonly string[]): Promise<{ shellPath: string; shellArgs: string[] }> {
    const target = await this.toolchain.resolveMpremote();
    return { shellPath: target.executable, shellArgs: [...target.prefixArgs, ...args] };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private assertLocalPortAccessible(target: string): void {
    if (process.platform === 'win32' || !target.startsWith('/')) {
      return;
    }
    try {
      fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw new DeviceCommandError(`Serial port does not exist: ${target}`, 'missing', error);
      }
      if (error?.code === 'EACCES') {
        throw new DeviceCommandError(
          `No read/write permission for ${target}. Check dialout/uaccess or the VS Code sandbox.`,
          'permission',
          error
        );
      }
      throw error;
    }
  }
}

function classifyProcessError(error: unknown): DeviceCommandError {
  if (!(error instanceof ProcessExecutionError)) {
    return new DeviceCommandError(String(error), 'command', error);
  }
  const details = `${error.message}\n${error.stderr}`;
  if (error.code === 'ENOENT') {
    return new DeviceCommandError(error.message, 'toolchain', error);
  }
  if (/permission denied|access is denied/i.test(details)) {
    return new DeviceCommandError(error.message, 'permission', error);
  }
  if (/in use|busy|resource busy|could not open port/i.test(details)) {
    return new DeviceCommandError(error.message, 'busy', error);
  }
  if (/no such file|does not exist/i.test(details)) {
    return new DeviceCommandError(error.message, 'missing', error);
  }
  return new DeviceCommandError(error.message, 'command', error);
}
