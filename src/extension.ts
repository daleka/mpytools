import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    // Функція для надсилання тексту в інтегрований термінал
    function sendToTerminal(text: string, terminalName: string = "MPY Session") {
        // Якщо вказано ім'я терміналу, спробуємо знайти його
        let terminal: vscode.Terminal | undefined;
        if (terminalName) {
            terminal = vscode.window.terminals.find(t => t.name === terminalName);
        }
        if (!terminal) {
            terminal = vscode.window.createTerminal(terminalName);
        }
        terminal.show();
        terminal.sendText(text);
    }

    // Створюємо статус-бар елемент для підключення
    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Створюємо статус-бар елемент для компіляції та монтування
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile & Mount';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати PY в MPY та змонтувати на пристрої';
    compileStatusBarItem.color = "blue";
    compileStatusBarItem.command = 'mpytools.compileAndMount';
    compileStatusBarItem.show();
    context.subscriptions.push(compileStatusBarItem);

    // Реєструємо команду для підключення до MicroPython
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        // Використовуємо основний термінал "MPY Session" для підключення
        sendToTerminal("mpremote connect auto repl", "MPY Session");

        // Симуляція підтвердження: через 2 секунди оновлюємо стан кнопки
        setTimeout(() => {
            connectionStatusBarItem.text = '$(check) MPY: Connected';
            connectionStatusBarItem.tooltip = 'Підключено до MicroPython пристрою';
            connectionStatusBarItem.color = "green";
        }, 2000);
    });
    context.subscriptions.push(disposableConnect);

    // Реєструємо команду для компіляції проекту (з папки PY у MPY) та монтування
    let disposableCompileAndMount = vscode.commands.registerCommand('mpytools.compileAndMount', () => {
        const compileAndMountCmd =
            // Видаляємо стару директорію MPY та створюємо нову
            `Remove-Item -Recurse -Force MPY -ErrorAction SilentlyContinue; ` +
            `New-Item -ItemType Directory -Path MPY | Out-Null; ` +
            // Обходимо всі .py файли у папці PY і компілюємо їх у MPY (зберігаючи структуру)
            `Get-ChildItem PY -Filter *.py -Recurse | ForEach-Object { ` +
                `$relPath = $_.FullName.Substring((Get-Item PY).FullName.Length + 1); ` +
                `$relPath = $relPath -replace '\\\\', '/'; ` +
                `$destPath = "MPY/" + ($relPath -replace "\\.py$", ".mpy"); ` +
                `if ($destPath -ne "") { ` +
                    `$parentPath = Split-Path -Parent $destPath; ` +
                    `if ($parentPath -and ($parentPath -ne "MPY")) { ` +
                        `New-Item -ItemType Directory -Path $parentPath -Force | Out-Null ` +
                    `} ` +
                `}; ` +
                `& "C:\\Program Files\\Python313\\Lib\\site-packages\\mpy_cross\\mpy-cross.exe" -O3 $_.FullName -o $destPath ` +
            `}; ` +
            // Монтуємо директорію MPY на пристрій через mpremote
            `mpremote mount MPY`;
        // Створюємо новий термінал для компіляції, щоб не заважати поточній сесії
        let compileTerminal = vscode.window.createTerminal("MPY Compile");
        compileTerminal.show();
        compileTerminal.sendText(compileAndMountCmd);
    });
    context.subscriptions.push(disposableCompileAndMount);
}

export function deactivate() {}
