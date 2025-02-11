import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    // Функція для надсилання тексту в інтегрований термінал
    function sendToTerminal(text: string) {
        let terminal = vscode.window.activeTerminal;
        if (!terminal) {
            terminal = vscode.window.createTerminal("MPY Session");
        }
        terminal.show();
        terminal.sendText(text);
    }

    // Створюємо статус-бар елемент для підключення
    // Змінюємо пріоритет на 0 (або навіть -1), щоб перемістити кнопку правіше
    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    // Призначаємо команду для цієї кнопки
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Реєструємо команду, яка викликається при натисканні статус-бар кнопки
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        // Надсилаємо команду підключення до MicroPython через mpremote
        sendToTerminal("mpremote connect auto repl");

        // Симуляція підтвердження: через 2 секунди оновлюємо стан кнопки
        setTimeout(() => {
            connectionStatusBarItem.text = '$(check) MPY: Connected';
            connectionStatusBarItem.tooltip = 'Підключено до MicroPython пристрою';
            // Використовуємо зелений колір
            connectionStatusBarItem.color = "green";
        }, 2000);
    });
    context.subscriptions.push(disposableConnect);
}

export function deactivate() {}
