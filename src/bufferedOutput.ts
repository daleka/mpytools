export type OutputSchedule = (callback: () => void, delayMs: number) => unknown;
export type OutputCancel = (handle: unknown) => void;

const DEFAULT_FLUSH_INTERVAL_MS = 150;
const DEFAULT_MAX_BUFFERED_CHARACTERS = 64 * 1024;

/**
 * Coalesces many small log writes into substantially fewer Output model
 * updates. This keeps the VS Code renderer responsive during parallel builds.
 */
export class BufferedTextWriter {
  private buffer = '';
  private timer: unknown | undefined;

  constructor(
    private readonly writeBlock: (text: string) => void,
    private readonly flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    private readonly maxBufferedCharacters = DEFAULT_MAX_BUFFERED_CHARACTERS,
    private readonly schedule: OutputSchedule = defaultSchedule,
    private readonly cancel: OutputCancel = defaultCancel
  ) {}

  append(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.buffer += text;
    if (this.buffer.length >= this.maxBufferedCharacters) {
      this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = this.schedule(() => {
        this.timer = undefined;
        this.flush();
      }, this.flushIntervalMs);
    }
  }

  appendLine(line: string): void {
    this.append(`${line}\n`);
  }

  flush(): void {
    this.cancelTimer();
    if (this.buffer.length === 0) {
      return;
    }
    const block = this.buffer;
    this.buffer = '';
    this.writeBlock(block);
  }

  discard(): void {
    this.cancelTimer();
    this.buffer = '';
  }

  dispose(): void {
    this.flush();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }
}

function defaultSchedule(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function defaultCancel(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
