//extension.ts

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// Імпортуємо функцію активації панелі з нового модуля
import { activateMpyToolsPanel } from './mpytoolsPanelActivator';

// Глобальна змінна для збереження терміналу (одна сесія для роботи з mpremote)
let mountedTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    // Створення статус-бару для підключення
    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Створення статус-бару для компіляції (без монтування)
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати файли з PY у MPY';
    compileStatusBarItem.color = "blue";
    compileStatusBarItem.command = 'mpytools.compile';
    context.subscriptions.push(compileStatusBarItem);

    // Створення статус-бару для керування сесією (Run, Stop, Restart)
    let runStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
    runStatusBarItem.text = '$(triangle-right) MPY: Run';
    runStatusBarItem.tooltip = 'Запускає main.py з теки MPY через exec (mpremote mount ... sleep ... exec(open(...).read()))';
    runStatusBarItem.command = 'mpytools.run';
    context.subscriptions.push(runStatusBarItem);

    let stopStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -3);
    stopStatusBarItem.text = '$(debug-stop) MPY: Stop';
    stopStatusBarItem.tooltip = 'Зупиняє виконання коду (soft-reset)';
    stopStatusBarItem.command = 'mpytools.stop';
    context.subscriptions.push(stopStatusBarItem);

    let restartStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -4);
    restartStatusBarItem.text = '$(refresh) MPY: Restart';
    restartStatusBarItem.tooltip = 'Перезапускає пристрій і запускає main (hard reset)';
    restartStatusBarItem.command = 'mpytools.restart';
    context.subscriptions.push(restartStatusBarItem);

    // За замовчуванням кнопки керування сесією приховані
    runStatusBarItem.hide();
    stopStatusBarItem.hide();
    restartStatusBarItem.hide();

    // Команда підключення
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('Відкрийте робочий простір для використання MPyTools.');
            return;
        }
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const pyFolderPath = path.join(workspacePath, 'PY');
        if (!fs.existsSync(pyFolderPath)) {
            vscode.window.showWarningMessage('MPyTools працює з папкою "PY". Переконайтеся, що ваш проєкт знаходиться в теці "PY".');
            return;
        }
        // Закриваємо всі термінали, що починаються з "MPY"
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name.startsWith("MPY")) {
                terminal.dispose();
            }
        });
        let terminal = vscode.window.createTerminal("MPY Session");
        terminal.show();
        connectionStatusBarItem.text = '$(sync~spin) MPY: Connecting...';
        connectionStatusBarItem.tooltip = 'Підключення до MicroPython пристрою...';
        connectionStatusBarItem.color = "yellow";
        // Підключення: автоматичне виявлення, вивід інформації та запуск REPL
        terminal.sendText(`mpremote connect auto exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);
        setTimeout(() => {
            connectionStatusBarItem.text = '$(check) MPY: Connected';
            connectionStatusBarItem.tooltip = 'Підключено до MicroPython пристрою';
            connectionStatusBarItem.color = "green";
            compileStatusBarItem.show();
        }, 2000);
    });
    context.subscriptions.push(disposableConnect);

    // Команда компіляції (без монтування)
    // Показуємо меню Quick Pick для вибору оптимізаційного рівня або варіанту "No Compile"
    let disposableCompile = vscode.commands.registerCommand('mpytools.compile', async () => {
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name.startsWith("MPY")) {
                terminal.dispose();
            }
        });
        const optLevel = await vscode.window.showQuickPick(
            ["No Compile", "O0", "O1", "O2", "O3"],
            { placeHolder: "Виберіть рівень оптимізації для компіляції (або 'No Compile' для копіювання без компіляції)" }
        );
        if (!optLevel) {
            vscode.window.showInformationMessage("Компіляцію скасовано.");
            return;
        }
        let compileCmd: string;
        if (optLevel === "No Compile") {
            // Просто копіюємо всі .py файли з PY у MPY без компіляції
            compileCmd =
                "Remove-Item -Recurse -Force MPY -ErrorAction SilentlyContinue; " +
                "New-Item -ItemType Directory -Path MPY | Out-Null; " +
                "Get-ChildItem PY -Filter *.py -Recurse | ForEach-Object { " +
                    "$relPath = $_.FullName.Substring((Get-Item PY).FullName.Length + 1); " +
                    "$relPath = $relPath -replace '\\\\', '/'; " +
                    "$destPath = 'MPY/' + $relPath; " +
                    "$parentPath = Split-Path -Parent $destPath; " +
                    "if ($parentPath -and ($parentPath -ne 'MPY')) { " +
                        "New-Item -ItemType Directory -Path $parentPath -Force | Out-Null; " +
                    "} " +
                    "Copy-Item $_.FullName -Destination $destPath; " +
                "};";
        } else {
            // Компiлюємо всі .py файли, крім main.py (який копіюється без змін)
            compileCmd =
                "Remove-Item -Recurse -Force MPY -ErrorAction SilentlyContinue; " +
                "New-Item -ItemType Directory -Path MPY | Out-Null; " +
                "Get-ChildItem PY -Filter *.py -Recurse | ForEach-Object { " +
                    "$relPath = $_.FullName.Substring((Get-Item PY).FullName.Length + 1); " +
                    "$relPath = $relPath -replace '\\\\', '/'; " +
                    "if ($_.Name -eq 'main.py') { " +
                        "$destPath = 'MPY/' + $relPath; " +
                        "$parentPath = Split-Path -Parent $destPath; " +
                        "if ($parentPath -and ($parentPath -ne 'MPY')) { " +
                            "New-Item -ItemType Directory -Path $parentPath -Force | Out-Null; " +
                        "} " +
                        "Copy-Item $_.FullName -Destination $destPath; " +
                    "} else { " +
                        "$destPath = 'MPY/' + ($relPath -replace '\\.py$', '.mpy'); " +
                        "if ($destPath -ne '') { " +
                            "$parentPath = Split-Path -Parent $destPath; " +
                            "if ($parentPath -and ($parentPath -ne 'MPY')) { " +
                                "New-Item -ItemType Directory -Path $parentPath -Force | Out-Null; " +
                            "} " +
                        "}; " +
                        `& 'C:\\Program Files\\Python313\\Lib\\site-packages\\mpy_cross\\mpy-cross.exe' -O${optLevel} $_.FullName -o $destPath; ` +
                    "} " +
                "};";
        }
        let compileTerminal = vscode.window.createTerminal("MPY Compile");
        compileTerminal.show();
        compileTerminal.sendText(compileCmd);
        mountedTerminal = compileTerminal;
        setTimeout(() => {
            runStatusBarItem.show();
            stopStatusBarItem.show();
            restartStatusBarItem.show();
        }, 2000);
    });
    context.subscriptions.push(disposableCompile);

    // Команда Run: монтує теку MPY, виводить структуру каталогу /remote і запускає main.py через exec
    let disposableRun = vscode.commands.registerCommand('mpytools.run', () => {
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name.startsWith("MPY")) {
                terminal.dispose();
            }
        });
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showWarningMessage('Відкрийте робочий простір.');
            return;
        }
        const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const mpyFolderPath = path.join(workspacePath, 'MPY');
        if (!fs.existsSync(mpyFolderPath)) {
            vscode.window.showWarningMessage('Папка "MPY" не знайдена.');
            return;
        }
        const mainFileName = "main.py";
        const mainFilePath = path.join(mpyFolderPath, mainFileName);
        if (!fs.existsSync(mainFilePath)) {
            vscode.window.showWarningMessage(`Файл "${mainFileName}" не знайдений у теці "MPY".`);
            return;
        }
        let runTerminal = vscode.window.createTerminal("MPY Run");
        runTerminal.show();
        // Формуємо команду:
        // 1. Монтуємо теку MPY як /remote
        // 2. Чекаємо 0.5 сек
        // 3. Виконуємо "fs ls /remote" для виводу структури каталогу (завершуємо аргументи знаком "+")
        // 4. Чекаємо ще 0.5 сек
        // 5. Виконуємо exec, який відкриває та виконує вміст /remote/main.py
        const runCmd = `mpremote mount "${mpyFolderPath}" sleep 0.5 fs ls /remote + sleep 0.5 exec "exec(open('/remote/${mainFileName}').read())"`;
        runTerminal.sendText(runCmd);
    });
    context.subscriptions.push(disposableRun);

    // Команда Stop: вихід з REPL і soft-reset
    let disposableStop = vscode.commands.registerCommand('mpytools.stop', () => {
        if (!mountedTerminal) {
            vscode.window.showErrorMessage('Сесія не знайдена. Спочатку виконайте Compile.');
            return;
        }
        const term = mountedTerminal;
        term.sendText("\x1d", true); // Ctrl-] для виходу з REPL
        setTimeout(() => {
            term.sendText("mpremote soft-reset", true);
        }, 500);
    });
    context.subscriptions.push(disposableStop);

    // Команда Restart: hard reset із запуском main через exec "import main" у тій же сесії
    let disposableRestart = vscode.commands.registerCommand('mpytools.restart', () => {
        if (!mountedTerminal) {
            vscode.window.showErrorMessage('Сесія не знайдена. Спочатку виконайте Compile.');
            return;
        }
        const term = mountedTerminal;
        term.sendText("\x1d", true);
        setTimeout(() => {
            term.sendText("mpremote reset sleep 0.5 exec \"import main\"", true);
        }, 500);
    });
    context.subscriptions.push(disposableRestart);

    // Активуємо панель MPyTools (новий функціонал) без зміни існуючого коду
    activateMpyToolsPanel(context);
}

export function deactivate() {}
