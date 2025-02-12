//mpytoolsPanel.ts

import * as vscode from 'vscode';

export class MpyToolsPanelItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label);
        this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    }
}

export class MpyToolsPanelProvider implements vscode.TreeDataProvider<MpyToolsPanelItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MpyToolsPanelItem | undefined | null | void> = new vscode.EventEmitter<MpyToolsPanelItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MpyToolsPanelItem | undefined | null | void> = this._onDidChangeTreeData.event;

    getTreeItem(element: MpyToolsPanelItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MpyToolsPanelItem): Thenable<MpyToolsPanelItem[]> {
        // Поки що повертаємо порожній список – панель залишається порожньою.
        return Promise.resolve([]);
    }
}
