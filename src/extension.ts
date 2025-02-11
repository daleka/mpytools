import * as vscode from 'vscode';
import { exec } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    // Створення статус-бару для підключення (індикатора)
    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    // Робимо індикатор клікабельним – при кліку викликається команда "mpytools.connect"
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Реєстрація команди підключення
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        // Закриваємо всі відкриті MPY-термінали
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name.startsWith("MPY")) {
                terminal.dispose();
            }
        });

        // Створюємо новий термінал для сесії підключення
        let terminal = vscode.window.createTerminal("MPY Session");
        terminal.show();

        // Оновлюємо індикатор – відображаємо, що відбувається підключення
        connectionStatusBarItem.text = '$(sync~spin) MPY: Connecting...';
        connectionStatusBarItem.tooltip = 'Підключення до MicroPython пристрою...';
        connectionStatusBarItem.color = "yellow";

        /* 
           Виконуємо ланцюжок команд:
           - mpremote connect auto – автоматичне підключення;
           - exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" – вивід даних про пристрій;
           - + repl – запуск REPL після виконання коду.
         */
        terminal.sendText(`mpremote connect auto exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);

        // Через 2 секунди оновлюємо індикатор до стану "Connected"
        setTimeout(() => {
            connectionStatusBarItem.text = '$(check) MPY: Connected';
            connectionStatusBarItem.tooltip = 'Підключено до MicroPython пристрою';
            connectionStatusBarItem.color = "green";
        }, 2000);
    });
    context.subscriptions.push(disposableConnect);

    // Створення статус-бару для компіляції та монтування
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile & Mount';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати PY в MPY та змонтувати на пристрої';
    compileStatusBarItem.color = "blue";
    compileStatusBarItem.command = 'mpytools.compileAndMount';
    compileStatusBarItem.show();
    context.subscriptions.push(compileStatusBarItem);

    // Реєстрація команди для компіляції (з папки PY у MPY) та монтування
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

export function deactivate() {}
