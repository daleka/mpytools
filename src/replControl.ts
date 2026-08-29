export interface ReplInput {
  sendText(text: string, shouldExecute?: boolean): void;
}

export type ReplDelay = (milliseconds: number) => Promise<void>;

export const REPL_CONNECTION_SETTLE_MS = 1_500;
export const REPL_INTERRUPT_SETTLE_MS = 300;

/**
 * Return a newly opened mpremote REPL to its prompt and execute the code
 * registered with --inject-code.
 */
export async function triggerReplInjection(
  terminal: ReplInput,
  wait: ReplDelay = delay
): Promise<void> {
  await wait(REPL_CONNECTION_SETTLE_MS);
  terminal.sendText('\x03', false);
  await wait(REPL_INTERRUPT_SETTLE_MS);
  terminal.sendText('\x0a', false);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
