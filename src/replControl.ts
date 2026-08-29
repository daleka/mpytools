export interface ReplInput {
  sendText(text: string, shouldExecute?: boolean): void;
}

export type ReplDelay = (milliseconds: number) => Promise<void>;

export const REPL_CONNECTION_SETTLE_MS = 1_500;
export const REPL_INTERRUPT_SETTLE_MS = 300;
export const REPL_COMMAND_SETTLE_MS = 200;
export const REPL_SOFT_RESET_SETTLE_MS = 1_500;

/**
 * Return a newly opened mpremote REPL to its prompt and submit ordinary REPL
 * commands through Enter. This intentionally mirrors MPyTools' proven legacy
 * launch flow instead of relying on mpremote's Ctrl-J injection shortcut.
 */
export async function runReplCommands(
  terminal: ReplInput,
  commands: readonly string[],
  wait: ReplDelay = delay
): Promise<void> {
  await wait(REPL_CONNECTION_SETTLE_MS);
  terminal.sendText('\x03', false);
  await wait(REPL_INTERRUPT_SETTLE_MS);
  for (let index = 0; index < commands.length; index++) {
    terminal.sendText(commands[index], true);
    if (index < commands.length - 1) {
      await wait(REPL_COMMAND_SETTLE_MS);
    }
  }
}

/**
 * Restart MicroPython from the friendly REPL. Ctrl-D follows the normal board
 * boot path, so boot.py and main.py are executed by MicroPython itself.
 * Optional commands are only needed for projects that ship a precompiled
 * main.mpy without a source main.py entry point.
 */
export async function restartMicroPythonInRepl(
  input: ReplInput,
  commandsAfterReset: readonly string[] = [],
  wait: ReplDelay = delay
): Promise<void> {
  await wait(REPL_CONNECTION_SETTLE_MS);
  input.sendText('\x03', false);
  await wait(REPL_INTERRUPT_SETTLE_MS);
  input.sendText('\x04', false);

  if (commandsAfterReset.length === 0) {
    return;
  }

  await wait(REPL_SOFT_RESET_SETTLE_MS);
  for (const command of commandsAfterReset) {
    input.sendText(command, true);
    await wait(REPL_COMMAND_SETTLE_MS);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
