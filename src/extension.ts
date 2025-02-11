import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

    // Створення статус-бару для компіляції та монтування
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile & Mount';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати PY в MPY та змонтувати на пристрої';
    compileStatusBarItem.color = "blue";
    compileStatusBarItem.command = 'mpytools.compileAndMount';
    // Спочатку не показуємо кнопку компіляції та монтування
    // compileStatusBarItem.show();
    context.subscriptions.push(compileStatusBarItem);

    // Реєстрація команди підключення
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        // Перевіряємо, чи відкритий робочий простір (workspace)
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('Відкрийте робочий простір для використання MPyTools.');
            return;
        }

        // Отримуємо шлях до кореневої теки першого workspace
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const pyFolderPath = path.join(workspacePath, 'PY');

        // Перевіряємо наявність папки "PY"
        if (!fs.existsSync(pyFolderPath)) {
            vscode.window.showWarningMessage(
                'Доповнення MPyTools працює з папкою "PY". Будь ласка, переконайтеся, що ваш проєкт знаходиться в теці "PY".\n' +
                'Якщо її немає, створіть теку "PY" у корені вашого робочого простору та помістіть у неї всі файли з розширенням .py.\n' +
                'Сам код компілюється та монтується саме з цієї теки, тому її відсутність може призвести до некоректної роботи доповнення.\n\n' +
                'MPyTools extension works with the folder "PY". Please ensure that your project is located inside a folder named "PY".\n' +
                'If it does not exist, create a folder called "PY" at the root of your workspace and place all your .py files inside it.\n' +
                'The code is compiled and mounted from this folder, so its absence may lead to incorrect extension behavior.'
            );
            return;
        }
        

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

        // Через 2 секунди оновлюємо індикатор до стану "Connected" та показуємо кнопку компіляції
        setTimeout(() => {
            connectionStatusBarItem.text = '$(check) MPY: Connected';
            connectionStatusBarItem.tooltip = 'Підключено до MicroPython пристрою';
            connectionStatusBarItem.color = "green";
            compileStatusBarItem.show();
        }, 2000);
    });
    context.subscriptions.push(disposableConnect);

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
