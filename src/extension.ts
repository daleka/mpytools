import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

// Це глобальна змінна, де ми зберігаємо останній вибраний порт.
let lastUsedPort: string = 'auto';

export function activate(context: vscode.ExtensionContext) {
    console.log('MPyTools розширення активоване.');

    // Статус-бар для підключення:
    let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    connectionStatusBarItem.text = '$(x) MPY: Not Connected';
    connectionStatusBarItem.tooltip = 'Натисніть, щоб підключитись до MicroPython пристрою';
    connectionStatusBarItem.color = "red";
    connectionStatusBarItem.command = 'mpytools.connect';
    connectionStatusBarItem.show();
    context.subscriptions.push(connectionStatusBarItem);

    // Кнопка "Compile & Run":
    let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
    compileStatusBarItem.text = '$(tools) MPY: Compile & Run';
    compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати та запустити проект';
    compileStatusBarItem.color = "lightblue";
    compileStatusBarItem.command = 'mpytools.compileAndRun';
    context.subscriptions.push(compileStatusBarItem);

    // Команда підключення:
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

                connectionStatusBarItem.text = '$(sync~spin) MPY: Connecting to ' + selectedPort + '...';
                connectionStatusBarItem.tooltip = 'Підключення до ' + selectedPort + '...';
                connectionStatusBarItem.color = 'yellow';

                // Закриваємо всі термінали, які починаються з "MPY"
                vscode.window.terminals.forEach((terminal) => {
                    if (terminal.name.startsWith('MPY')) {
                        terminal.dispose();
                    }
                });

                let connectTerminal = vscode.window.createTerminal('MPY Session');
                connectTerminal.show();

                if (selectedPort === 'auto') {
                    connectTerminal.sendText('mpremote connect auto exec "import os, gc; print(os.uname()); print(\'Free memory:\', gc.mem_free())" + repl');
                } else {
                    let formattedPort = formatPort(selectedPort);
                    connectTerminal.sendText(
                        'mpremote connect ' + formattedPort + ' exec "import os, gc; print(os.uname()); print(\'Free memory:\', gc.mem_free())" + repl'
                    );
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
                            connectionStatusBarItem.text = '$(check) MPY: Connected to ' + selectedPort;
                            connectionStatusBarItem.tooltip = 'Підключено до ' + selectedPort;
                            connectionStatusBarItem.color = 'green';
                            compileStatusBarItem.show();
                        }
                    });
                }, 3000);
            });
        });
    });
    context.subscriptions.push(disposableConnect);

    // Метод компіляції та запуску:
    let disposableCompileAndRun = vscode.commands.registerCommand('mpytools.compileAndRun', async () => {
        let workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Не знайдено відкритий Workspace. Відкрийте папку проекту у VS Code.');
            return;
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const srcPath = path.join(workspaceRoot, 'src');
        const mpyPath = path.join(workspaceRoot, 'mpy');

        // Закриваємо всі термінали, які починаються з "MPY"
        vscode.window.terminals.forEach((t) => {
            if (t.name.startsWith('MPY')) {
                t.dispose();
            }
        });

        // Створюємо термінал "MPY Compile&download"
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

        let compiledCount = 0;
        let newlyCompiledMpyPaths: string[] = [];

        for (const pyFile of pyFiles) {
            if (needsRecompile(pyFile, srcPath, mpyPath)) {
                compileTerminal.sendText(`echo 'Компілємо: ${pyFile}'`);
                try {
                    let outMpy = await compilePyFile(pyFile, srcPath, mpyPath, compileTerminal);
                    newlyCompiledMpyPaths.push(outMpy);
                    compiledCount++;
                } catch (err: any) {
                    compileTerminal.sendText(`echo 'Помилка компіляції: ${err}'`);
                }
            } else {
                compileTerminal.sendText(`echo 'Пропускаємо: ${pyFile} (не змінювався)'`);
            }
        }
        compileTerminal.sendText(`echo '>>> Компільовано: ${compiledCount} (із ${pyFiles.length})'`);

        let copiedCount = 0;
        if (newlyCompiledMpyPaths.length === 0) {
            compileTerminal.sendText(`echo 'Немає нових .mpy для копіювання.'`);
        } else {
            compileTerminal.sendText(`echo 'Копіюємо ${newlyCompiledMpyPaths.length} .mpy на пристрій...'`);
        }

        for (const localMpy of newlyCompiledMpyPaths) {
            let relativeMpy = path.relative(mpyPath, localMpy);
            compileTerminal.sendText(`echo 'Копіюємо: ${relativeMpy}'`);
            try {
                await copySingleFileToDevice(localMpy, relativeMpy, usedPort, compileTerminal);
                copiedCount++;
            } catch (err: any) {
                compileTerminal.sendText(`echo 'Помилка копіювання: ${err}'`);
            }
        }
        compileTerminal.sendText(`echo 'Скопійовано .mpy: ${copiedCount}'`);

        // Додаємо затримку 500 мс після завершення копіювання
        await new Promise(resolve => setTimeout(resolve, 500));

        // Створюємо термінал "MPY Debugging" і запускаємо main
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
        const cmd = `${mpyCrossPath} -O3 "${pyFilePath}" -o "${outPath}"`;

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

async function copySingleFileToDevice(
    localMpy: string,
    relativeMpy: string,
    port: string,
    terminal: vscode.Terminal
) {
    const devicePath = ':' + relativeMpy.replace(/\\/g, '/');
    await ensureDeviceDirectories(port, path.dirname(devicePath).replace(/^:/, ''), terminal);

    return new Promise<void>((resolve, reject) => {
        let cmd = '';
        if (port === 'auto') {
            cmd = `mpremote connect auto fs cp "${localMpy}" "${devicePath}"`;
        } else {
            cmd = `mpremote connect ${port} fs cp "${localMpy}" "${devicePath}"`;
        }

        terminal.sendText(`echo '[mpremote cp] ${cmd}'`);

        exec(cmd, (error, stdout, stderr) => {
            if (stdout && stdout.trim()) {
                terminal.sendText(`echo '[cp stdout] ${stdout.trim()}'`);
            }
            if (stderr && stderr.trim()) {
                terminal.sendText(`echo '[cp stderr] ${stderr.trim()}'`);
            }
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

async function ensureDeviceDirectories(
    port: string,
    deviceDir: string,
    terminal: vscode.Terminal
): Promise<void> {
    if (!deviceDir || deviceDir === '.' || deviceDir === '') {
        return;
    }
    const dirs = deviceDir.split('/').filter((d) => d.trim() !== '');

    let currentPath = '';
    for (const dir of dirs) {
        if (!dir) {
            continue;
        }
        currentPath = currentPath ? currentPath + '/' + dir : dir;

        let mkdirCmd = '';
        if (port === 'auto') {
            mkdirCmd = `mpremote connect auto fs mkdir ":${currentPath}"`;
        } else {
            mkdirCmd = `mpremote connect ${port} fs mkdir ":${currentPath}"`;
        }

        terminal.sendText(`echo '[mkdir] ${mkdirCmd}'`);
        try {
            await execPromise(mkdirCmd);
        } catch (err: any) {
            const message = err?.message || '';
            if (!message.includes('already exists')) {
                terminal.sendText(`echo '[mkdir err] ${message}'`);
            }
        }
    }
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
    }, 1000);
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
