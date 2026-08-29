import * as vscode from 'vscode';
import { BufferedTextWriter } from './bufferedOutput';

/** A vscode.OutputChannel that batches writes while preserving its public API. */
export class BufferedOutputChannel implements vscode.OutputChannel {
  private readonly writer: BufferedTextWriter;

  constructor(private readonly channel: vscode.OutputChannel, flushIntervalMs = 150) {
    this.writer = new BufferedTextWriter((text) => channel.append(text), flushIntervalMs);
  }

  get name(): string {
    return this.channel.name;
  }

  append(value: string): void {
    this.writer.append(value);
  }

  appendLine(value: string): void {
    this.writer.appendLine(value);
  }

  clear(): void {
    this.writer.discard();
    this.channel.clear();
  }

  replace(value: string): void {
    this.writer.discard();
    this.channel.replace(value);
  }

  show(preserveFocus?: boolean): void;
  show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
    this.writer.flush();
    if (typeof columnOrPreserveFocus === 'boolean' || columnOrPreserveFocus === undefined) {
      this.channel.show(columnOrPreserveFocus);
    } else {
      this.channel.show(columnOrPreserveFocus, preserveFocus);
    }
  }

  hide(): void {
    this.writer.flush();
    this.channel.hide();
  }

  dispose(): void {
    this.writer.dispose();
    this.channel.dispose();
  }
}
