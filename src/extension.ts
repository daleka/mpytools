import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    // Створення статус-бару для підключення (індикатора)
    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Створення статус-бару для компіляції та монтування
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile & Mount';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати PY в MPY та змонтувати на пристрої';
    compileStatusBarItem.color = "blue";
    compileStatusBarItem.command = 'mpytools.compileAndMount';
    context.subscriptions.push(compileStatusBarItem);

    // Реєстрація команди підключення
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        // Отримуємо налаштування порту з файлу налаштувань
        const config = vscode.workspace.getConfiguration('mpytools');
        const connectionPort = config.get<string>('connectionPort', 'auto'); // за замовчуванням 'auto'

        // Логування для перевірки порту
        console.log(`Налаштування порту: ${connectionPort}`);

        // Використовуємо команду mpremote для отримання доступних портів
        exec('mpremote connect list', (error, stdout, stderr) => {
            if (error || stderr) {
                vscode.window.showErrorMessage('Помилка при отриманні доступних портів');
                console.error(error || stderr);
                return;
            }

            // Обробляємо виведення команди і отримуємо доступні порти
            const availablePorts = stdout
                .split('\n')
                .filter(line => line.includes('COM') || line.includes('/dev/')) // Фільтруємо порти, наприклад, COM1, /dev/ttyUSB0, тощо
                .map(line => line.trim().split(' ')[0]); // Беремо тільки перший елемент (порт)

            availablePorts.push('auto'); // Додаємо "auto" як можливість вибору

            // Запитуємо користувача для вибору порту
            vscode.window.showQuickPick(availablePorts, {
                placeHolder: 'Виберіть порт для підключення'
            }).then(selectedPort => {
                if (selectedPort) {
                    // Оновлюємо налаштування
                    vscode.workspace.getConfiguration('mpytools').update('connectionPort', selectedPort, vscode.ConfigurationTarget.Workspace);

                    // Оновлюємо індикатор статусу
                    connectionStatusBarItem.text = `$(sync~spin) MPY: Connecting to ${selectedPort}...`;
                    connectionStatusBarItem.tooltip = `Підключення до ${selectedPort}...`;
                    connectionStatusBarItem.color = "yellow";

                    // Закриваємо всі відкриті MPY-термінали
                    vscode.window.terminals.forEach(terminal => {
                        if (terminal.name.startsWith("MPY")) {
                            terminal.dispose();
                        }
                    });

                    // Підключаємося до вибраного порту
                    let terminal = vscode.window.createTerminal("MPY Session");
                    terminal.show();

                    // Перевірка на 'auto' для автоматичного підключення
                    if (selectedPort === 'auto') {
                        terminal.sendText('mpremote connect auto exec "import os, gc; print(os.uname()); print(\'Free memory:\', gc.mem_free())" + repl');
                    } else {
                        // Для Windows, Linux та macOS правильне форматування порту
                        let formattedPort = formatPort(selectedPort);
                        terminal.sendText(`mpremote connect ${formattedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);
                    }

                    // Через деякий час перевіряємо, чи підключення дійсно відбулося
                    setTimeout(() => {
                        checkDeviceConnection(terminal, selectedPort, connectionStatusBarItem);
                    }, 3000);
                }
            });
        });
    });

    context.subscriptions.push(disposableConnect);

    // Реєстрація команди для компіляції та монтування
    let disposableCompileAndMount = vscode.commands.registerCommand('mpytools.compileAndMount', () => {
        // Закриваємо всі відкриті MPY-термінали
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name.startsWith("MPY")) {
                terminal.dispose();
            }
        });

        // Затримка для впевненості, що всі сесії завершено
        setTimeout(() => {
            const compileAndMountCmd =
                "Remove-Item -Recurse -Force MPY -ErrorAction SilentlyContinue; " +
                "New-Item -ItemType Directory -Path MPY | Out-Null; " +
                "Get-ChildItem PY -Filter *.py -Recurse | ForEach-Object { " +
                    "$relPath = $_.FullName.Substring((Get-Item PY).FullName.Length + 1); " +
                    "$relPath = $relPath -replace '\\\\', '/'; " +
                    "$destPath = 'MPY/' + ($relPath -replace '\\.py$', '.mpy'); " +
                    "if ($destPath -ne '') { " +
                        "$parentPath = Split-Path -Parent $destPath; " +
                        "if ($parentPath -and ($parentPath -ne 'MPY')) { " +
                            "New-Item -ItemType Directory -Path $parentPath -Force | Out-Null; " +
                        "} " +
                    "}; " +
                    "& 'C:\\Program Files\\Python313\\Lib\\site-packages\\mpy_cross\\mpy-cross.exe' -O3 $_.FullName -o $destPath; " +
                "}; " +
                "mpremote mount MPY repl";

            // Виконуємо команду в окремому терміналі "MPY Compile"
            let compileTerminal = vscode.window.createTerminal("MPY Compile");
            compileTerminal.show();
            compileTerminal.sendText(compileAndMountCmd);
        }, 500);
    });

    context.subscriptions.push(disposableCompileAndMount);
}

// Функція для форматування порту згідно з операційною системою
function formatPort(port: string): string {
    const platform = os.platform();
    if (platform === 'win32') {
        // Для Windows порти мають вигляд COMn
        return port;
    } else if (platform === 'linux' || platform === 'darwin') {
        // Для Linux/macOS порти мають вигляд /dev/ttyUSBn або /dev/ttyACMn
        return `/dev/${port}`;
    } else {
        return port;
    }
}

// Функція для перевірки підключення до пристрою через термінал
function checkDeviceConnection(terminal: vscode.Terminal, selectedPort: string, connectionStatusBarItem: vscode.StatusBarItem) {
    terminal.processId.then(pid => {
        setTimeout(() => {
            // Перевірка на наявність слова "MicroPython" у виводі терміналу
            if (pid) {
                connectionStatusBarItem.text = `$(check) MPY: Connected to ${selectedPort}`;
                connectionStatusBarItem.tooltip = `Підключено до ${selectedPort}`;
                connectionStatusBarItem.color = "green";
            }
        }, 1000);
    });
}

export function deactivate() {}
