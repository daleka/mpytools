import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

// Це ГЛОБАЛЬНА змінна, де ми тимчасово зберігаємо останній вибраний порт.
// За замовчуванням "auto".
let lastUsedPort: string = 'auto';

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    // --- Кнопка/індикатор підключення ---
    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // --- Кнопка "Compile & Run" (буде показуватись після підключення) ---
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile & Run';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати та запустити проект';
    compileStatusBarItem.color = "lightblue";
    compileStatusBarItem.command = 'mpytools.compileAndRun';
    context.subscriptions.push(compileStatusBarItem);

    // --- Команда підключення ---
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {

        // Отримуємо список доступних портів через mpremote
        exec('mpremote connect list', (error, stdout, stderr) => {
            if (error || stderr) {
                vscode.window.showErrorMessage('Помилка при отриманні доступних портів');
                console.error(error || stderr);
                return;
            }

            const availablePorts = stdout
                .split('\n')
                .filter(line => line.includes('COM') || line.includes('/dev/'))
                .map(line => line.trim().split(' ')[0]);
            // Додаємо 'auto'
            availablePorts.push('auto'); 

            vscode.window.showQuickPick(availablePorts, {
                placeHolder: 'Виберіть порт для підключення (поточний: ' + lastUsedPort + ')'
            }).then(selectedPort => {
                if (!selectedPort) { 
                    return; 
                }

                // Запам'ятовуємо порт у змінній (не у settings.json!)
                lastUsedPort = selectedPort;
                console.log(`[MPyTools] Порт обрано: ${lastUsedPort}`);

                // Індикатор "Connecting..."
                connectionStatusBarItem.text = `$(sync~spin) MPY: Connecting to ${selectedPort}...`;
                connectionStatusBarItem.tooltip = `Підключення до ${selectedPort}...`;
                connectionStatusBarItem.color = "yellow";

                // Закриваємо всі відкриті MPY-термінали
                vscode.window.terminals.forEach(terminal => {
                    if (terminal.name.startsWith("MPY")) {
                        terminal.dispose();
                    }
                });

                // Створюємо новий термінал
                let terminal = vscode.window.createTerminal("MPY Session");
                terminal.show();

                // Відправляємо команду підключення + repl (перевірка стану)
                if (selectedPort === 'auto') {
                    terminal.sendText('mpremote connect auto exec "import os, gc; print(os.uname()); print(\'Free memory:\', gc.mem_free())" + repl');
                } else {
                    let formattedPort = formatPort(selectedPort);
                    terminal.sendText(`mpremote connect ${formattedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);
                }

                // Перевіряємо успішність підключення
                let connectionVerified = false;
                const timeout = setTimeout(() => {
                    if (!connectionVerified) {
                        connectionStatusBarItem.text = `$(x) MPY: Not Connected`;
                        connectionStatusBarItem.tooltip = `Підключення не вдалося`;
                        connectionStatusBarItem.color = "red";
                    }
                }, 10000);

                setTimeout(() => {
                    verifyDeviceConnection(selectedPort, (success) => {
                        if (success) {
                            connectionVerified = true;
                            clearTimeout(timeout);
                            connectionStatusBarItem.text = `$(check) MPY: Connected to ${selectedPort}`;
                            connectionStatusBarItem.tooltip = `Підключено до ${selectedPort}`;
                            connectionStatusBarItem.color = "green";
                            // Тепер показуємо кнопку "Compile & Run"
                            compileStatusBarItem.show();
                        }
                    });
                }, 3000);
            });
        });
    });
    context.subscriptions.push(disposableConnect);

    // --- Метод компіляції та запуску ---
    let disposableCompileAndRun = vscode.commands.registerCommand('mpytools.compileAndRun', async () => {
        // Спершу переконаємося, що у нас є відкритий Workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage("Не знайдено відкритий Workspace. Будь ласка, відкрийте папку проекту у VS Code.");
            return;
        }

        // Беремо корінь першого (або єдиного) Workspace
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const srcPath = path.join(workspaceRoot, "src");
        const mpyPath = path.join(workspaceRoot, "mpy");

        // Закриваємо всі відкриті MPY-термінали
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name.startsWith("MPY")) {
                terminal.dispose();
            }
        });

        // Тепер беремо останній вибраний порт з глобальної змінної
        // Якщо користувач жодного разу не натискав Connect, лишається 'auto'
        const usedPort = lastUsedPort;
        console.log(`[MPyTools] Використовується порт: ${usedPort}`);

        // Форматуємо порт, якщо він не 'auto'
        let formattedPort = (usedPort === 'auto') ? 'auto' : formatPort(usedPort);

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Компіляція та завантаження на пристрій",
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 0, message: "Початок процесу..." });

                // 1. Видаляємо папку mpy (якщо є) і створюємо з нуля
                await removeDirectoryIfExists(mpyPath);
                fs.mkdirSync(mpyPath);

                // 2. Збираємо .py файли з папки src 
                let pyFiles = findPyFiles(srcPath, []);

                // 3. Компілюємо кожен .py у .mpy
                let compiledCount = 0;
                for (let i = 0; i < pyFiles.length; i++) {
                    const filePath = pyFiles[i];
                    await compilePyFile(filePath, srcPath, mpyPath);
                    compiledCount++;
                    let percent = Math.floor((compiledCount / pyFiles.length) * 30); 
                    progress.report({ 
                        increment: percent, 
                        message: `Компіляція: ${compiledCount}/${pyFiles.length} файлів...` 
                    });
                }

                // 4. Знаходимо усі .mpy файли в папці mpy
                let mpyFiles = findMpyFiles(mpyPath, []);

                // 5. Копіюємо файли на пристрій по одному
                let copiedCount = 0;
                const totalToCopy = mpyFiles.length;
                for (let i = 0; i < mpyFiles.length; i++) {
                    const localMpyPath = mpyFiles[i];
                    const relativeMpyPath = path.relative(mpyPath, localMpyPath);
                    await copySingleFileToDevice(localMpyPath, relativeMpyPath, formattedPort);

                    copiedCount++;
                    let percentCopy = Math.floor((copiedCount / totalToCopy) * 60);
                    progress.report({ 
                        increment: 30 + percentCopy, 
                        message: `Копіювання: ${copiedCount}/${totalToCopy} файлів...` 
                    });
                }

                // 6. Після успішного копіювання виконуємо main, викликаючи main.run()
                progress.report({ increment: 95, message: "Запуск main.mpy (main.run())..." });
                openTerminalAndRunMain(formattedPort);

                progress.report({ increment: 100, message: "Готово!" });
                vscode.window.showInformationMessage("Скомпільовано, завантажено та запущено main.mpy на пристрої (REPL у новому терміналі).");
            } catch (err: any) {
                console.error("Помилка при компіляції/завантаженні:", err);
                vscode.window.showErrorMessage("Помилка при компіляції або завантаженні. Деталі у консолі.");
            }
        });
    });
    context.subscriptions.push(disposableCompileAndRun);
}

/**
 * Відкриває новий термінал, де виконується:
 *   mpremote connect {port} exec "import main" + repl
 * Потім у REPL викликається main.run().
 */
function openTerminalAndRunMain(port: string) {
    const terminal = vscode.window.createTerminal("MPY Debugging");
    terminal.show();

    const connectCommand = (port === 'auto')
        ? `mpremote connect auto exec "import main" + repl`
        : `mpremote connect ${port} exec "import main" + repl`;

    terminal.sendText(connectCommand);

    setTimeout(() => {
        terminal.sendText(`main.run()`);
    }, 1000);
}

function formatPort(port: string): string {
    const platform = os.platform();
    if (platform === 'win32') {
        return port; // COM3, COM4...
    } else if (platform === 'linux' || platform === 'darwin') {
        return `/dev/${port}`;
    }
    return port;
}

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
                // Якщо порт уже зайнятий поточною сесією
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

function findPyFiles(rootDir: string, ignoreList: string[] = []): string[] {
    let results: string[] = [];
    function recurse(currentDir: string) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (let entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                recurse(fullPath);
            } else if (entry.isFile() && entry.name.endsWith(".py")) {
                if (!ignoreList.includes(entry.name)) {
                    results.push(fullPath);
                }
            }
        }
    }
    if (fs.existsSync(rootDir)) {
        recurse(rootDir);
    }
    return results;
}

function findMpyFiles(rootDir: string, ignoreList: string[] = []): string[] {
    let results: string[] = [];
    function recurse(currentDir: string) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (let entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                recurse(fullPath);
            } else if (entry.isFile() && entry.name.endsWith(".mpy")) {
                if (!ignoreList.includes(entry.name)) {
                    results.push(fullPath);
                }
            }
        }
    }
    if (fs.existsSync(rootDir)) {
        recurse(rootDir);
    }
    return results;
}

async function compilePyFile(pyFilePath: string, srcPath: string, mpyPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const relative = path.relative(srcPath, pyFilePath);
        const outPath = path.join(mpyPath, relative.replace(/\.py$/, ".mpy"));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        
        const mpyCrossPath = `"C:\\Program Files\\Python313\\Lib\\site-packages\\mpy_cross\\mpy-cross.exe"`;
        const cmd = `${mpyCrossPath} -O3 "${pyFilePath}" -o "${outPath}"`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error("Помилка при компіляції:", stderr || error.message);
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function copySingleFileToDevice(localMpyPath: string, relativeMpyPath: string, port: string) {
    const devicePath = `:${relativeMpyPath.replace(/\\/g, "/")}`;
    const deviceDir = path.dirname(devicePath).replace(/^:/, '');

    if (deviceDir && deviceDir !== '.') {
        await ensureDeviceDirectories(port, deviceDir);
    }

    return new Promise<void>((resolve, reject) => {
        let cmd = '';
        if (port === 'auto') {
            cmd = `mpremote connect auto fs cp "${localMpyPath}" "${devicePath}"`;
        } else {
            cmd = `mpremote connect ${port} fs cp "${localMpyPath}" "${devicePath}"`;
        }

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error("Помилка копіювання файлу:", stderr || error.message);
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function removeDirectoryIfExists(dirPath: string) {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
}

async function ensureDeviceDirectories(port: string, deviceDir: string): Promise<void> {
    if (!deviceDir) {
        return;
    }
    const dirs = deviceDir.split('/').filter(d => d.trim() !== '');

    let currentPath = '';
    for (const dir of dirs) {
        if (!dir) continue;
        currentPath = currentPath ? (currentPath + '/' + dir) : dir;
        let mkdirCmd = '';

        if (port === 'auto') {
            mkdirCmd = `mpremote connect auto fs mkdir ":${currentPath}"`;
        } else {
            mkdirCmd = `mpremote connect ${port} fs mkdir ":${currentPath}"`;
        }

        try {
            await execPromise(mkdirCmd);
        } catch (err: any) {
            const msg = err?.message || '';
            if (!msg.includes("already exists")) {
                console.warn("mkdir помилка, можливо директорія вже існує:", msg);
            }
        }
    }
}

function execPromise(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            if (stderr && stderr.trim()) {
                reject(new Error(stderr));
                return;
            }
            resolve(stdout);
        });
    });
}

export function deactivate() {}
