import * as vscode from 'vscode';
import { DeviceCommandError, MpremoteService } from './mpremoteService';
import { normalizePortTarget, SerialPortDescriptor, stablePortTarget } from './ports';
import { triggerReplInjection } from './replControl';

const SELECTED_PORT_KEY = 'mpytools.selectedPort.v2';

export class DeviceSession implements vscode.Disposable {
  private selected: SerialPortDescriptor | undefined;
  private interactiveTerminal: vscode.Terminal | undefined;
  private terminalClosed: Promise<void> = Promise.resolve();
  private resolveTerminalClosed: (() => void) | undefined;
  private readonly closeSubscription: vscode.Disposable;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mpremote: MpremoteService
  ) {
    this.selected = context.globalState.get<SerialPortDescriptor>(SELECTED_PORT_KEY);
    this.closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === this.interactiveTerminal) {
        this.interactiveTerminal = undefined;
        this.resolveTerminalClosed?.();
        this.resolveTerminalClosed = undefined;
      }
    });
  }

  currentPort(): string {
    return this.selected ? normalizePortTarget(this.selected.path) : 'auto';
  }

  currentDescriptor(): SerialPortDescriptor | undefined {
    return this.selected;
  }

  async select(port: SerialPortDescriptor | undefined): Promise<void> {
    await this.exclusive(async () => {
      await this.closeInteractiveTerminalInternal();
      this.selected = port;
      await this.context.globalState.update(SELECTED_PORT_KEY, port);
    });
  }

  async restore(): Promise<SerialPortDescriptor | undefined> {
    if (!this.selected) {
      return undefined;
    }
    try {
      const available = await this.mpremote.listPorts();
      const matched = available.find((candidate) =>
        (this.selected?.serialNumber && candidate.serialNumber === this.selected.serialNumber)
        || candidate.path === this.selected?.path
      );
      if (matched) {
        this.selected = matched;
        await this.context.globalState.update(SELECTED_PORT_KEY, matched);
        return matched;
      }
    } catch {
      // Keep the previous selection; the diagnostics command will explain failures.
    }
    return undefined;
  }

  async run(args: readonly string[], options: { timeoutMs?: number; cwd?: string } = {}) {
    return this.exclusive(async () => {
      await this.closeInteractiveTerminalInternal();
      try {
        return await this.mpremote.runOnPort(this.connectTarget(), args, options);
      } catch (error) {
        if (
          error instanceof DeviceCommandError
          && error.kind === 'missing'
          && this.selected?.serialNumber
          && await this.restore()
        ) {
          return this.mpremote.runOnPort(this.connectTarget(), args, options);
        }
        throw error;
      }
    });
  }

  async openRepl(name = 'MPY REPL', injectCode?: string): Promise<vscode.Terminal> {
    const args = ['connect', this.connectTarget(), 'repl'];
    if (injectCode) {
      args.push('--inject-code', injectCode);
    }
    return this.exclusive(async () => {
      const terminal = await this.openCommandTerminal(name, args);
      if (injectCode) {
        // mpremote's --inject-code only registers the code behind Ctrl-J; it
        // does not execute it automatically. Wait until VS Code has created
        // the terminal process and mpremote has entered its console, interrupt
        // any program already running on the board, then trigger injection.
        await waitForTerminalProcess(terminal);
        await triggerReplInjection(terminal);
      }
      return terminal;
    });
  }

  async openRunFile(filePath: string, name = 'MPY Run'): Promise<vscode.Terminal> {
    return this.exclusive(() => this.openCommandTerminal(name, ['connect', this.connectTarget(), 'run', filePath]));
  }

  private async openCommandTerminal(name: string, args: string[]): Promise<vscode.Terminal> {
    await this.closeInteractiveTerminalInternal();
    const invocation = await this.mpremote.terminalInvocation(args);
    this.terminalClosed = new Promise<void>((resolve) => {
      this.resolveTerminalClosed = resolve;
    });
    this.interactiveTerminal = vscode.window.createTerminal({
      name,
      shellPath: invocation.shellPath,
      shellArgs: invocation.shellArgs,
      isTransient: true
    });
    this.interactiveTerminal.show();
    return this.interactiveTerminal;
  }

  stopInteractive(): boolean {
    if (!this.interactiveTerminal) {
      return false;
    }
    this.interactiveTerminal.sendText('\x03', false);
    return true;
  }

  async closeInteractiveTerminal(): Promise<void> {
    await this.exclusive(() => this.closeInteractiveTerminalInternal());
  }

  private async closeInteractiveTerminalInternal(): Promise<void> {
    const terminal = this.interactiveTerminal;
    if (!terminal) {
      return;
    }
    terminal.dispose();
    await Promise.race([
      this.terminalClosed,
      new Promise<void>((resolve) => setTimeout(resolve, 3_000))
    ]);
    if (this.interactiveTerminal === terminal) {
      this.interactiveTerminal = undefined;
      this.resolveTerminalClosed = undefined;
    }
  }

  dispose(): void {
    this.interactiveTerminal?.dispose();
    this.closeSubscription.dispose();
  }

  private connectTarget(): string {
    return this.selected ? stablePortTarget(this.selected) : 'auto';
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}

async function waitForTerminalProcess(terminal: vscode.Terminal, timeoutMs = 3_000): Promise<void> {
  await Promise.race([
    Promise.resolve(terminal.processId).then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}
