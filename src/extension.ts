//extension.ts

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { activateMpyToolsPanel } from './mpytoolsPanelActivator';

let mountedTerminal: vscode.Terminal | undefined;
let selectedPort: string | null = null;  // Глобальна змінна для збереження вибраного порту

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Інші статус-бар елементи залишаються незмінними...

    // Команда підключення
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        if (selectedPort) {
            // Якщо вибрано порт, підключаємось до нього
            const terminal = vscode.window.createTerminal(`MPY Session (${selectedPort})`);
            terminal.show();
            connectionStatusBarItem.text = '$(sync~spin) MPY: Connecting...';
            connectionStatusBarItem.tooltip = `Підключення до порту ${selectedPort}...`;
            connectionStatusBarItem.color = "yellow";
            terminal.sendText(`mpremote connect ${selectedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);
        } else {
            // Якщо порт не вибрано, підключаємось автоматично
            const terminal = vscode.window.createTerminal("MPY Session");
            terminal.show();
            connectionStatusBarItem.text = '$(sync~spin) MPY: Connecting...';
            connectionStatusBarItem.tooltip = 'Підключення до MicroPython пристрою...';
            connectionStatusBarItem.color = "yellow";
            terminal.sendText(`mpremote connect auto exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);
        }

        setTimeout(() => {
            connectionStatusBarItem.text = '$(check) MPY: Connected';
            connectionStatusBarItem.tooltip = 'Підключено до MicroPython пристрою';
            connectionStatusBarItem.color = "green";
        }, 2000);
    });
    context.subscriptions.push(disposableConnect);

    // Інші команди залишаються незмінними...

    activateMpyToolsPanel(context);
}

export function deactivate() {}
