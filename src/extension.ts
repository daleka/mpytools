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

    // Створення статус-бару для компіляції та запуску (спочатку не показується)
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile & Run';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати PY та запустити на пристрої';
    compileStatusBarItem.color = "lightblue";
    compileStatusBarItem.command = 'mpytools.compileAndRun';
    // compileStatusBarItem.show(); // Не показуємо спочатку
    context.subscriptions.push(compileStatusBarItem);

    // Реєстрація команди підключення
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        // Отримуємо налаштування порту з файлу налаштувань
        const config = vscode.workspace.getConfiguration('mpytools');
        const connectionPort = config.get<string>('connectionPort', 'auto'); // за замовчуванням 'auto'
        console.log(`Налаштування порту: ${connectionPort}`);

        // Отримуємо список доступних портів за допомогою mpremote
        exec('mpremote connect list', (error, stdout, stderr) => {
            if (error || stderr) {
                vscode.window.showErrorMessage('Помилка при отриманні доступних портів');
                console.error(error || stderr);
                return;
            }

            // Обробляємо вивід та отримуємо список портів
            const availablePorts = stdout
                .split('\n')
                .filter(line => line.includes('COM') || line.includes('/dev/'))
                .map(line => line.trim().split(' ')[0]);
            availablePorts.push('auto'); // додаємо "auto" як можливість

            // Запит користувача для вибору порту
            vscode.window.showQuickPick(availablePorts, {
                placeHolder: 'Виберіть порт для підключення'
            }).then(selectedPort => {
                if (selectedPort) {
                    // Оновлюємо налаштування
                    vscode.workspace.getConfiguration('mpytools')
                        .update('connectionPort', selectedPort, vscode.ConfigurationTarget.Workspace);

                    // Встановлюємо індикатор у стан "Connecting" (жовтий)
                    connectionStatusBarItem.text = `$(sync~spin) MPY: Connecting to ${selectedPort}...`;
                    connectionStatusBarItem.tooltip = `Підключення до ${selectedPort}...`;
                    connectionStatusBarItem.color = "yellow";

                    // При успішному підключенні покажемо кнопку Compile & Run
                    // (спочатку кнопка компіляції була прихована)

                    // Закриваємо всі відкриті MPY-термінали
                    vscode.window.terminals.forEach(terminal => {
                        if (terminal.name.startsWith("MPY")) {
                            terminal.dispose();
                        }
                    });

                    // Використовуємо інтегрований термінал VSCode за замовчуванням
                    let terminal = vscode.window.createTerminal("MPY Session");
                    terminal.show();

                    // Відправляємо команду підключення (для інтерактивної сесії додаємо + repl)
                    if (selectedPort === 'auto') {
                        terminal.sendText('mpremote connect auto exec "import os, gc; print(os.uname()); print(\'Free memory:\', gc.mem_free())" + repl');
                    } else {
                        let formattedPort = formatPort(selectedPort);
                        terminal.sendText(`mpremote connect ${formattedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);
                    }

                    // Змінна для відстеження успішності підключення
                    let connectionVerified = false;

                    // Через 10 секунд, якщо підключення не підтверджено – повертаємо статус у "Not Connected"
                    const timeout = setTimeout(() => {
                        if (!connectionVerified) {
                            connectionStatusBarItem.text = `$(x) MPY: Not Connected`;
                            connectionStatusBarItem.tooltip = `Підключення не вдалося`;
                            connectionStatusBarItem.color = "red";
                        }
                    }, 10000);

                    // Через 3 секунди запускаємо перевірку підключення
                    setTimeout(() => {
                        verifyDeviceConnection(selectedPort, (success) => {
                            if (success) {
                                connectionVerified = true;
                                clearTimeout(timeout);
                                connectionStatusBarItem.text = `$(check) MPY: Connected to ${selectedPort}`;
                                connectionStatusBarItem.tooltip = `Підключено до ${selectedPort}`;
                                connectionStatusBarItem.color = "green";
                                // Показуємо кнопку Compile & Run
                                compileStatusBarItem.show();
                            }
                        });
                    }, 3000);
                }
            });
        });
    });
    context.subscriptions.push(disposableConnect);

    // Реєстрація команди для компіляції та запуску
    let disposableCompileAndRun = vscode.commands.registerCommand('mpytools.compileAndRun', () => {
        // Закриваємо всі відкриті MPY-термінали
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name.startsWith("MPY")) {
                terminal.dispose();
            }
        });

        // Отримуємо збережений порт із налаштувань
        const config = vscode.workspace.getConfiguration('mpytools');
        const connectionPort = config.get<string>('connectionPort', 'auto');
        
        // Затримка для впевненості, що всі сесії завершено
        setTimeout(() => {
            // Команда компіляції та запуску. Тут виконується компіляція файлів з директорії PY,
            // після чого відбувається монтування (з використанням обраного порту)
            let formattedPort = connectionPort === 'auto' ? 'auto' : formatPort(connectionPort);
            const compileAndRunCmd =
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
                // Використовуємо збережений порт у команді підключення для монтування
                (formattedPort === 'auto'
                    ? 'mpremote connect auto mount MPY repl'
                    : `mpremote connect ${formattedPort} mount MPY repl`);
            
            let compileTerminal = vscode.window.createTerminal("MPY Compile");
            compileTerminal.show();
            compileTerminal.sendText(compileAndRunCmd);
        }, 500);
    });
    context.subscriptions.push(disposableCompileAndRun);
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

/**
 * Функція перевірки підключення.
 * Виконується через exec із тією ж командою, що й для підключення,
 * і аналізує вивід: якщо він містить "Free memory:" – підключення успішне.
 * Якщо виникає помилка, але текст містить "failed to access", також повертаємо успіх,
 * оскільки це означає, що порт уже використовується поточною сесією.
 */
function verifyDeviceConnection(selectedPort: string, callback: (success: boolean) => void) {
    let command: string;
    if (selectedPort === 'auto') {
        command = 'mpremote connect auto exec "import os, gc; print(os.uname()); print(\'Free memory:\', gc.mem_free())"';
    } else {
        let formattedPort = formatPort(selectedPort);
        command = `mpremote connect ${formattedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())"`;
    }
    exec(command, (error, stdout, stderr) => {
        if (error || stderr) {
            const errText = error ? error.message : stderr;
            if (errText && errText.includes("failed to access")) {
                callback(true);
            } else {
                console.error("Помилка при перевірці підключення:", errText);
                callback(false);
            }
        } else {
            if (stdout && stdout.includes("Free memory:")) {
                callback(true);
            } else {
                callback(false);
            }
        }
    });
}

export function deactivate() {}
