import * as vscode from 'vscode';

// Створюємо елемент дерева для відображення портів з можливістю встановлення галочки
export class MpyToolsPanelItem extends vscode.TreeItem {
    constructor(label: string, public portPath: string, public isChecked: boolean = false) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.command = {
            command: 'mpytools.selectPort',
            title: 'Select Port',
            arguments: [this.portPath]
        };
        this.checkbox = this.isChecked ? '$(check)' : '$(circle-outline)';
        this.updatePresentation();
    }

    // Виводимо статус чекбоксу поряд з назвою порту
    checkbox: string;

    updatePresentation(): void {
        this.label = `${this.checkbox} ${this.portPath}`;
        this.tooltip = `Click to ${this.isChecked ? 'deselect' : 'select'} this port`;
    }
}

// Модель даних для дерева панелі
export class MpyToolsPanelProvider implements vscode.TreeDataProvider<MpyToolsPanelItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MpyToolsPanelItem | undefined | null | void> = new vscode.EventEmitter<MpyToolsPanelItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MpyToolsPanelItem | undefined | null | void> = this._onDidChangeTreeData.event;

    public ports: MpyToolsPanelItem[] = [];
    private selectedPort: string | null = null;  // Зберігаємо вибраний порт

    constructor() {
        this.loadPorts();
    }

    // Завантажуємо доступні порти
    private async loadPorts() {
        try {
            const result = await this.execCommand('mpremote list');
            const lines = result.split('\n');
            this.ports = lines
                .filter(line => line.trim() !== '')
                .map(line => {
                    const portName = line.trim();
                    return new MpyToolsPanelItem(portName, portName);
                });
            this._onDidChangeTreeData.fire();
        } catch (err) {
            console.error('Error loading ports: ', err);
        }
    }

    private execCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            require('child_process').exec(command, (error: any, stdout: string, stderr: string) => {
                if (error) {
                    reject(stderr);
                    return;
                }
                resolve(stdout);
            });
        });
    }

    // Оновлюємо чекбокс для вибраного порту
    private togglePortSelection(port: string) {
        const selectedPortIndex = this.ports.findIndex(item => item.portPath === port);
        if (selectedPortIndex !== -1) {
            this.ports.forEach(item => {
                item.isChecked = false;
                item.checkbox = '$(circle-outline)';
                item.updatePresentation();
            });
            this.ports[selectedPortIndex].isChecked = true;
            this.ports[selectedPortIndex].checkbox = '$(check)';
            this.ports[selectedPortIndex].updatePresentation();
            this.selectedPort = port;
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: MpyToolsPanelItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MpyToolsPanelItem): Thenable<MpyToolsPanelItem[]> {
        return Promise.resolve(this.ports);
    }

    // Зареєстрована команда для вибору порту
    registerPortSelectionCommand(context: vscode.ExtensionContext) {
        vscode.commands.registerCommand('mpytools.selectPort', (port: string) => {
            this.togglePortSelection(port);
        });
    }
}
