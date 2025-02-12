//mpytoolsPanelActivator.ts

import * as vscode from 'vscode';
import { MpyToolsPanelProvider } from './mpytoolsPanel';

export function activateMpyToolsPanel(context: vscode.ExtensionContext) {
    const panelProvider = new MpyToolsPanelProvider();
    const treeView = vscode.window.createTreeView('mpytoolsSettings', { treeDataProvider: panelProvider });
    context.subscriptions.push(treeView);

    const disposable = vscode.commands.registerCommand('mpytools.showSettings', () => {
        vscode.window.showInformationMessage('Панель MPyTools налаштувань активована!');
    });
    context.subscriptions.push(disposable);
}
