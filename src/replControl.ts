export interface ReplInput {
  sendText(text: string, shouldExecute?: boolean): void;
}

export type ReplDelay = (milliseconds: number) => Promise<void>;

export const REPL_CONNECTION_SETTLE_MS = 1_500;
export const REPL_INTERRUPT_SETTLE_MS = 300;
export const REPL_COMMAND_SETTLE_MS = 200;

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

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
