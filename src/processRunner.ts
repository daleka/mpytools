import { execFile } from 'child_process';

export interface CommandTarget {
  executable: string;
  prefixArgs: string[];
  source: 'configured' | 'managed' | 'path' | 'python-module';
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    public readonly executable: string,
    public readonly args: readonly string[],
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code?: string | number,
    public readonly timedOut = false
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

export function runProcess(
  target: CommandTarget,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<ProcessResult> {
  const invocationArgs = [...target.prefixArgs, ...args];
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    execFile(
      target.executable,
      invocationArgs,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          const errorCode = 'code' in error ? (error.code ?? undefined) : undefined;
          const timedOut = Boolean(error.killed && error.signal === 'SIGTERM' && timeoutMs > 0);
          const details = timedOut
            ? `Command timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`
            : (stderr.trim() || stdout.trim() || error.message);
          reject(new ProcessExecutionError(
            details,
            target.executable,
            invocationArgs,
            stdout,
            stderr,
            errorCode,
            timedOut
          ));
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      }
    );
  });
}

export function formatCommand(target: CommandTarget, args: readonly string[]): string {
  return [target.executable, ...target.prefixArgs, ...args].map(quoteForDisplay).join(' ');
}

function quoteForDisplay(value: string): string {
  if (/^[\w@%+=:,./-]+$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
