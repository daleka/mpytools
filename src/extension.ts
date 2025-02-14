import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

// Це глобальна змінна, де ми зберігаємо останній вибраний порт.
let lastUsedPort: string = 'auto';
// Глобальна змінна для збереження обраного методу компіляції mpy-cross (0, 1, 2 або 3).
let selectedCompilationMethod: string | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    // Створюємо статус-бар для підключення
    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Створюємо кнопку "Compile & Run"
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile & Run';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати та запустити проект';
    compileStatusBarItem.color = "lightblue";
    compileStatusBarItem.command = 'mpytools.compileAndRun';
    context.subscriptions.push(compileStatusBarItem);

    // Команда підключення
    let disposableConnect = vscode.commands.registerCommand('mpytools.connect', () => {
        exec('mpremote connect list', (error, stdout, stderr) => {
            if (error || stderr) {
                vscode.window.showErrorMessage('Помилка при отриманні доступних портів');
                console.error(error || stderr);
                return;
            }
            const availablePorts = stdout
                .split('\n')
                .filter((line) => line.includes('COM') || line.includes('/dev/'))
                .map((line) => line.trim().split(' ')[0]);
            availablePorts.push('auto');
            vscode.window.showQuickPick(availablePorts, {
                placeHolder: 'Виберіть порт для підключення (поточний: ' + lastUsedPort + ')'
            }).then((selectedPort) => {
                if (!selectedPort) {
                    return;
                }
                lastUsedPort = selectedPort;
                console.log('[MPyTools] Порт обрано: ' + lastUsedPort);
                connectionStatusBarItem.text = `$(sync~spin) MPY: Connecting to ${selectedPort}...`;
                connectionStatusBarItem.tooltip = `Підключення до ${selectedPort}...`;
                connectionStatusBarItem.color = 'yellow';

                vscode.window.terminals.forEach((terminal) => {
                    if (terminal.name.startsWith('MPY')) {
                        terminal.dispose();
                    }
                });
                let connectTerminal = vscode.window.createTerminal('MPY Session');
                connectTerminal.show();
                if (selectedPort === 'auto') {
                    connectTerminal.sendText(`mpremote connect auto exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);
                } else {
                    let formattedPort = formatPort(selectedPort);
                    connectTerminal.sendText(`mpremote connect ${formattedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);
                }
                let connectionVerified = false;
                const timeout = setTimeout(() => {
                    if (!connectionVerified) {
                        connectionStatusBarItem.text = '$(x) MPY: Not Connected';
                        connectionStatusBarItem.tooltip = 'Підключення не вдалося';
                        connectionStatusBarItem.color = 'red';
                    }
                }, 10000);
                setTimeout(() => {
                    verifyDeviceConnection(selectedPort, (success) => {
                        if (success) {
                            connectionVerified = true;
                            clearTimeout(timeout);
                            connectionStatusBarItem.text = `$(check) MPY: Connected to ${selectedPort}`;
                            connectionStatusBarItem.tooltip = `Підключено до ${selectedPort}`;
                            connectionStatusBarItem.color = 'green';
                            compileStatusBarItem.show();
                        }
                    });
                }, 3000);
            });
        });
    });
    context.subscriptions.push(disposableConnect);

    // Метод компіляції та запуску
    let disposableCompileAndRun = vscode.commands.registerCommand('mpytools.compileAndRun', async () => {
        let workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Не знайдено відкритий Workspace. Відкрийте папку проекту у VS Code.');
            return;
        }

        if (!selectedCompilationMethod) {
            const compilationOptions: vscode.QuickPickItem[] = [
                { label: 'mpy-cross optimization Level 0', description: 'Без оптимізації' },
                { label: 'mpy-cross optimization Level 1', description: 'Базова оптимізація' },
                { label: 'mpy-cross optimization Level 2', description: 'Середня оптимізація' },
                { label: 'mpy-cross optimization Level 3', description: 'Максимальна оптимізація' }
            ];
            const result = await vscode.window.showQuickPick(compilationOptions, {
                placeHolder: 'Оберіть метод компіляції mpy-cross (оптимізація)',
                canPickMany: false
            });
            if (!result) {
                vscode.window.showWarningMessage('Компіляцію скасовано: не обрано метод компіляції.');
                return;
            }
            const match = result.label.match(/Level (\d+)/);
            selectedCompilationMethod = match ? match[1] : '0';
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const srcPath = path.join(workspaceRoot, 'src');
        const mpyPath = path.join(workspaceRoot, 'mpy');

        vscode.window.terminals.forEach((t) => {
            if (t.name.startsWith('MPY')) {
                t.dispose();
            }
        });
        await new Promise(resolve => setTimeout(resolve, 500));

        let compileTerminal = vscode.window.createTerminal('MPY Compile&download');
        compileTerminal.show();

        compileTerminal.sendText(`echo '==== MPyTools: Початок компіляції та завантаження ===='`);
        const usedPort = lastUsedPort;
        compileTerminal.sendText(`echo '[MPyTools] Використовується порт: ${usedPort}'`);

        if (!fs.existsSync(mpyPath)) {
            fs.mkdirSync(mpyPath);
            compileTerminal.sendText(`echo 'Створено директорію: ${mpyPath}'`);
        }

        let pyFiles = findPyFiles(srcPath, []);
        compileTerminal.sendText(`echo 'Знайдено .py файлів: ${pyFiles.length}'`);

        // Встановлюємо індикатор у режим "Please wait..." під час компіляції та копіювання
        compileStatusBarItem.color = 'red';
        compileStatusBarItem.text = '$(sync~spin) MPY: Please wait...';

        let compiledCount = 0;
        for (let i = 0; i < pyFiles.length; i++) {
            const pyFile = pyFiles[i];
            if (needsRecompile(pyFile, srcPath, mpyPath)) {
                compileTerminal.sendText(`echo 'Компілємо: ${pyFile}'`);
                try {
                    await compilePyFile(pyFile, srcPath, mpyPath, compileTerminal);
                    compiledCount++;
                } catch (err: any) {
                    compileTerminal.sendText(`echo 'Помилка компіляції: ${err}'`);
                }
            } else {
                compileTerminal.sendText(`echo 'Пропускаємо: ${pyFile} (не змінювався)'`);
            }
        }
        compileTerminal.sendText(`echo '>>> Компільовано: ${compiledCount} (із ${pyFiles.length})'`);

        // Фаза копіювання
        let copyPath = mpyPath;
        if (os.platform() === 'win32') {
            copyPath = copyPath + '\\.';
        } else {
            copyPath = copyPath + '/.';
        }
        compileTerminal.sendText(`echo 'Копіюємо директорію mpy на пристрій за допомогою mpremote cp -r...'`);
        const copyCmd = (usedPort === 'auto') ?
            `mpremote connect auto fs cp -r "${copyPath}" ":/"` :
            `mpremote connect ${formatPort(usedPort)} fs cp -r "${copyPath}" ":/"`;
        compileTerminal.sendText(`echo '[mpremote cp -r] ${copyCmd}'`);

        try {
            await execPromise(copyCmd);
            compileTerminal.sendText(`echo 'Копіювання завершено.'`);
        } catch (err: any) {
            compileTerminal.sendText(`echo 'Помилка при копіюванні: ${err}'`);
            return;
        }

        // Після завершення операцій повертаємо індикатор до стандартного вигляду
        compileStatusBarItem.text = '$(tools) MPY: Compile & Run';
        compileStatusBarItem.color = 'lightblue';

        await new Promise(resolve => setTimeout(resolve, 500));

        let debugTerminal = vscode.window.createTerminal('MPY Debugging');
        debugTerminal.show();

        compileTerminal.sendText(`echo 'Запускаємо main (термінал MPY Debugging)...'`);
        openTerminalAndRunMain((usedPort === 'auto') ? 'auto' : formatPort(usedPort), debugTerminal);

        compileTerminal.sendText(`echo '==== Завершено. ===='`);
    });
    context.subscriptions.push(disposableCompileAndRun);
}

function needsRecompile(pyFilePath: string, srcPath: string, mpyPath: string): boolean {
    const relative = path.relative(srcPath, pyFilePath);
    const outPath = path.join(mpyPath, relative.replace(/\.py$/, '.mpy'));
    if (!fs.existsSync(outPath)) {
        return true;
    }
    const pyStat = fs.statSync(pyFilePath);
    const mpyStat = fs.statSync(outPath);
    return (pyStat.mtime > mpyStat.mtime);
}

async function compilePyFile(
    pyFilePath: string,
    srcPath: string,
    mpyPath: string,
    terminal: vscode.Terminal
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const relative = path.relative(srcPath, pyFilePath);
        const outPath = path.join(mpyPath, relative.replace(/\.py$/, '.mpy'));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const mpyCrossPath = '"C:\\Program Files\\Python313\\Lib\\site-packages\\mpy_cross\\mpy-cross.exe"';
        const cmd = `${mpyCrossPath} -O${selectedCompilationMethod} "${pyFilePath}" -o "${outPath}"`;
        terminal.sendText(`echo '[mpy-cross cmd] ${cmd}'`);
        exec(cmd, (error, stdout, stderr) => {
            if (stdout && stdout.trim()) {
                terminal.sendText(`echo '[mpy-cross stdout] ${stdout.trim()}'`);
            }
            if (stderr && stderr.trim()) {
                terminal.sendText(`echo '[mpy-cross stderr] ${stderr.trim()}'`);
            }
            if (error) {
                reject(error);
            } else {
                resolve(outPath);
            }
        });
    });
}

function openTerminalAndRunMain(port: string, debugTerminal: vscode.Terminal) {
    let connectCmd = '';
    if (port === 'auto') {
        connectCmd = 'mpremote connect auto exec "import main" + repl';
    } else {
        connectCmd = `mpremote connect ${port} exec "import main" + repl`;
    }
    debugTerminal.sendText(connectCmd);
    setTimeout(() => {
        debugTerminal.sendText('main.run()');
    }, 2000);
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

function formatPort(port: string): string {
    const platform = os.platform();
    if (platform === 'win32') {
        return port;
    } else if (platform === 'linux' || platform === 'darwin') {
        return `/dev/${port}`;
    }
    return port;
}

function verifyDeviceConnection(selectedPort: string, callback: (success: boolean) => void) {
    let command = '';
    if (selectedPort === 'auto') {
        command = 'mpremote connect auto exec "import os, gc; print(os.uname()); print(\'Free memory:\', gc.mem_free())"';
    } else {
        let formattedPort = formatPort(selectedPort);
        command = `mpremote connect ${formattedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())"`;
    }
    exec(command, (error, stdout, stderr) => {
        if (error || stderr) {
            const errText = error ? error.message : stderr;
            if (errText && errText.includes('failed to access')) {
                callback(true);
            } else {
                console.error('Помилка при перевірці підключення:', errText);
                callback(false);
            }
        } else {
            if (stdout && stdout.includes('Free memory:')) {
                callback(true);
            } else {
                callback(false);
            }
        }
    });
}

function findPyFiles(rootDir: string, ignoreList: string[] = []): string[] {
    let results: string[] = [];
    function recurse(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (let entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                recurse(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.py')) {
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

export function deactivate() {
    // Додаткові дії при деактивації, якщо потрібно.
}
