import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { registerDependenciesCommand } from './dependenciesInstaller';

// Створюємо один глобальний Output Channel
export const mpyOutputChannel = vscode.window.createOutputChannel("MPyTools Log");

// Це глобальна змінна, де ми зберігаємо останній вибраний порт.
let lastUsedPort: string = 'auto';
// Глобальна змінна для збереження обраного методу компіляції mpy-cross (0, 1, 2 або 3).
let selectedCompilationMethod: string | undefined = undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('MPyTools розширення активоване.');

  // Створимо й зареєструємо команду встановлення залежностей
  // (передаючи посилання на mpyOutputChannel, щоб там вести лог)
  registerDependenciesCommand(context, mpyOutputChannel);

  // При активації одразу питаємо користувача про встановлення залежностей
  vscode.window.showInformationMessage(
    "MPyTools needs dependencies:\n- mpremote\n- mpy-cross\n- micropython-stdlib-stubs\nInstall them now?",
    "Yes",
    "No"
  ).then((choice) => {
    if (choice === "Yes") {
      vscode.commands.executeCommand('mpytools.installDependencies');
    } else {
      console.log("User chose not to install dependencies.");
    }
  });

  // ----------------------------------------------------------------------
  // Статус-бар для вибору порту
  let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  connectionStatusBarItem.text = '$(plug) Select Port';
  connectionStatusBarItem.tooltip = 'Click to select a MicroPython port';
  connectionStatusBarItem.color = 'red'; // Червоний на початку
  connectionStatusBarItem.command = 'mpytools.selectPort';
  connectionStatusBarItem.show();
  context.subscriptions.push(connectionStatusBarItem);

  // Створюємо кнопку "Compile & Run" (прихована до вибору порту)
  let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
  compileStatusBarItem.text = '$(tools) MPY: Compile & Run';
  compileStatusBarItem.tooltip = 'Натисніть, щоб скомпілювати та запустити проект';
  compileStatusBarItem.color = "lightblue";
  compileStatusBarItem.command = 'mpytools.compileAndRun';
  compileStatusBarItem.hide();
  context.subscriptions.push(compileStatusBarItem);

  // Кнопки Run, Stop, Reset
  let runStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  runStatusBarItem.text = '$(play) Run';
  runStatusBarItem.tooltip = 'Запустити активний файл';
  runStatusBarItem.command = 'mpytools.runActive';
  runStatusBarItem.hide();

  let stopStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  stopStatusBarItem.text = '$(debug-stop) Stop';
  stopStatusBarItem.tooltip = 'Зупинити виконання (Ctrl-C)';
  stopStatusBarItem.command = 'mpytools.stop';
  stopStatusBarItem.hide();

  let resetStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  resetStatusBarItem.text = '$(refresh) Reset';
  resetStatusBarItem.tooltip = 'Hard reset the device (mpremote connect <port> reset)';
  resetStatusBarItem.color = "#ff6666";
  resetStatusBarItem.command = 'mpytools.resetHard';
  resetStatusBarItem.hide();

  context.subscriptions.push(runStatusBarItem);
  context.subscriptions.push(stopStatusBarItem);
  context.subscriptions.push(resetStatusBarItem);

  // --------------------------
  // Реєструємо команди Run, Stop, Reset
  // --------------------------

  vscode.commands.registerCommand('mpytools.runActive', async (): Promise<void> => {
    // Закриваємо всі термінали MPY, крім "MPY Compile&download"
    const terminalsToClose = vscode.window.terminals.filter(t =>
      t.name.startsWith("MPY") && t.name !== "MPY Compile&download"
    );
    terminalsToClose.forEach(t => t.dispose());

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Немає активного файлу для запуску.");
      return;
    }
    const filePath = editor.document.uri.fsPath;

    mpyOutputChannel.appendLine("🔹 Run active file: " + filePath);

    let runTerminal = vscode.window.createTerminal('MPY Run');
    runTerminal.show();
    runTerminal.sendText(`mpremote run "${filePath}"`);
  });

  vscode.commands.registerCommand('mpytools.stop', async (): Promise<void> => {
    const terminal = vscode.window.activeTerminal;
    if (terminal) {
      terminal.sendText("\x03", false); // Ctrl-C
      vscode.window.showInformationMessage("Stop: Ctrl-C надіслано. (Execution stopped)");
      mpyOutputChannel.appendLine("✅ Stop signal (Ctrl-C) sent.");
    } else {
      vscode.window.showWarningMessage("Немає активного терміналу.");
    }
  });

  vscode.commands.registerCommand('mpytools.resetHard', async (): Promise<void> => {
    try {
      const terminalsToClose = vscode.window.terminals.filter(t =>
        t.name.startsWith("MPY")
      );
      terminalsToClose.forEach(t => t.dispose());

      const usedPort = (lastUsedPort === 'auto') ? 'auto' : formatPort(lastUsedPort);
      mpyOutputChannel.appendLine(`🔹 Hard Reset on port "${lastUsedPort}"`);

      let resetTerminal = vscode.window.createTerminal('MPY Reset');
      resetTerminal.show();
      resetTerminal.sendText(`mpremote connect ${usedPort} reset`);

      vscode.window.showInformationMessage(`Device hard-reset requested on port "${lastUsedPort}"`);
      mpyOutputChannel.appendLine("✅ Hard reset command sent.");
    } catch (err: any) {
      vscode.window.showErrorMessage("Failed to reset (hard-reset) device: " + err);
      mpyOutputChannel.appendLine("❌ Error resetting device: " + err.message);
    }
  });

  // ======================
  // Команда для вибору порту
  // ======================
  let disposableSelectPort = vscode.commands.registerCommand('mpytools.selectPort', (): void => {
    exec('mpremote connect list', (error, stdout, stderr) => {
      if (error || stderr) {
        console.error("Error listing ports:", error || stderr);
        mpyOutputChannel.appendLine("❌ Error listing ports: " + (error?.message || stderr));
      }

      let availablePorts: string[] = [];
      if (!error && !stderr) {
        availablePorts = stdout
          .split('\n')
          .filter((line) => line.includes('COM') || line.includes('/dev/'))
          .map((line) => line.trim().split(' ')[0]);
      }
      if (!availablePorts.includes('auto')) {
        availablePorts.push('auto');
      }

      vscode.window.showQuickPick(availablePorts, {
        placeHolder: 'Select a port to use (current: ' + lastUsedPort + ')'
      }).then((selectedPort) => {
        if (!selectedPort) {
          return;
        }
        lastUsedPort = selectedPort;

        // Спочатку показуємо "Connecting..." зі спінером
        connectionStatusBarItem.text = '$(sync~spin) MPY: Connecting...';
        connectionStatusBarItem.color = 'yellow';
        connectionStatusBarItem.tooltip = 'Connecting to the device...';

        mpyOutputChannel.appendLine(`🔹 Selected port: "${lastUsedPort}"`);

        // Закриваємо попередні MPY-термінали
        vscode.window.terminals
          .filter(t => t.name.startsWith("MPY"))
          .forEach(t => t.dispose());

        // Новий термінал для сеансу
        let connectTerminal = vscode.window.createTerminal('MPY Session');
        connectTerminal.show();
        const usedPort = (lastUsedPort === 'auto') ? 'auto' : formatPort(lastUsedPort);
        connectTerminal.sendText(`mpremote connect ${usedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`);

        // Через 2с оновимо статус-бар
        setTimeout(() => {
          connectionStatusBarItem.text = `$(check) MPY: Using ${lastUsedPort}`;
          connectionStatusBarItem.color = 'green';
          connectionStatusBarItem.tooltip = 'Port selected';

          compileStatusBarItem.show();
          runStatusBarItem.show();
          stopStatusBarItem.show();
          resetStatusBarItem.show();

          mpyOutputChannel.appendLine(`✅ Connected to port: "${lastUsedPort}"`);
        }, 2000);
      });
    });
  });
  context.subscriptions.push(disposableSelectPort);

  // ======================
  // Команда компіляції та запуску
  // ======================
  let disposableCompileAndRun = vscode.commands.registerCommand('mpytools.compileAndRun', async (): Promise<void> => {
    let workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('Не знайдено відкритий Workspace. (No workspace folder opened)');
      return;
    }

    // Якщо ще не вибраний рівень оптимізації, питаємо
    if (!selectedCompilationMethod) {
      const compilationOptions: vscode.QuickPickItem[] = [
        { label: 'mpy-cross optimization Level 0', description: 'Без оптимізації / No optimization' },
        { label: 'mpy-cross optimization Level 1', description: 'Базова оптимізація / Basic optimization' },
        { label: 'mpy-cross optimization Level 2', description: 'Середня оптимізація / Medium optimization' },
        { label: 'mpy-cross optimization Level 3', description: 'Максимальна оптимізація / Max optimization' }
      ];
      const result = await vscode.window.showQuickPick(compilationOptions, {
        placeHolder: 'Оберіть метод компіляції / Choose mpy-cross optimization level',
        canPickMany: false
      });
      if (!result) {
        vscode.window.showWarningMessage('Компіляцію скасовано / Compilation canceled: no method selected.');
        return;
      }
      const match = result.label.match(/Level (\d+)/);
      selectedCompilationMethod = match ? match[1] : '0';
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const srcPath = path.join(workspaceRoot, 'src');
    const mpyPath = path.join(workspaceRoot, 'mpy');

    // Перед початком – очищуємо попередні термінали MPY
    vscode.window.terminals.forEach((t) => {
      if (t.name.startsWith('MPY')) {
        t.dispose();
      }
    });

    // Трошки почекаємо (щоб встигли закритися)
    await new Promise(resolve => setTimeout(resolve, 300));

    // **Ось тут** активуємо Output Channel, щоб користувач бачив лог
    mpyOutputChannel.show(false); // false -> робить активним канал
    mpyOutputChannel.appendLine("🔹 Starting Compile & Run process...");
    mpyOutputChannel.appendLine(`   - Selected optimization level: O${selectedCompilationMethod}`);

    // Короткий індикатор прогресу (по кроках)
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'MPyTools: Compile & Run',
      cancellable: false
    }, async (progress) => {
      try {
        // Крок 1: Перевірка/створення папки mpy
        progress.report({ message: 'Preparing compilation...' });
        mpyOutputChannel.appendLine("🔹 Preparing compilation...");

        if (!fs.existsSync(mpyPath)) {
          fs.mkdirSync(mpyPath);
          vscode.window.showInformationMessage(`Created directory (Створено теку): ${mpyPath}`);
          mpyOutputChannel.appendLine(`   ✅ Created directory: ${mpyPath}`);
        }

        // Пошук .py файлів
        let pyFiles = findPyFiles(srcPath, []);
        mpyOutputChannel.appendLine(`   🔹 Found ${pyFiles.length} .py files in "src"`);
        progress.report({ message: `Found ${pyFiles.length} .py files...` });

        // Змінюємо вигляд кнопки, щоб показати обробку
        compileStatusBarItem.color = 'red';
        compileStatusBarItem.text = '$(sync~spin) MPY: Please wait...';

        let compiledCount = 0;
        for (let i = 0; i < pyFiles.length; i++) {
          const pyFile = pyFiles[i];
          const shortName = path.relative(workspaceRoot, pyFile);

          if (needsRecompile(pyFile, srcPath, mpyPath)) {
            progress.report({ message: `Compiling: ${shortName}` });
            mpyOutputChannel.appendLine(`   🔹 Compiling: ${shortName}`);

            try {
              await compilePyFile(pyFile, srcPath, mpyPath);
              compiledCount++;
              mpyOutputChannel.appendLine(`      ✅ OK: ${shortName}`);
            } catch (err: any) {
              vscode.window.showWarningMessage(`Compilation error (Помилка компіляції): ${shortName}\n${err}`);
              mpyOutputChannel.appendLine(`      ❌ Compilation error: ${shortName} -> ${err.message}`);
            }
          } else {
            mpyOutputChannel.appendLine(`   🔹 Skipped (unchanged): ${shortName}`);
          }
        }

        mpyOutputChannel.appendLine(`   ✅ Compiled ${compiledCount} / ${pyFiles.length} py-files`);
        vscode.window.showInformationMessage(`Compiled (скомпільовано) ${compiledCount} out of (із) ${pyFiles.length}.`);

        // Крок 2: Копіювання .mpy файлів на пристрій
        let copyPath = mpyPath;
        if (os.platform() === 'win32') {
          copyPath = copyPath + '\\.';
        } else {
          copyPath = copyPath + '/.';
        }
        progress.report({ message: 'Copying files to device...' });
        mpyOutputChannel.appendLine("🔹 Copying compiled files to device...");

        const usedPort = lastUsedPort;
        const copyCmd = (usedPort === 'auto')
          ? `mpremote connect auto fs cp -r "${copyPath}" ":/"`
          : `mpremote connect ${formatPort(usedPort)} fs cp -r "${copyPath}" ":/"`;

        try {
          await execPromise(copyCmd);
          vscode.window.showInformationMessage('Copy complete (Копіювання завершено).');
          mpyOutputChannel.appendLine("   ✅ Copy complete.");
        } catch (err: any) {
          vscode.window.showErrorMessage(`Error copying files (Помилка копіювання): ${err}`);
          mpyOutputChannel.appendLine(`   ❌ Error copying files: ${err.message}`);
          compileStatusBarItem.text = '$(tools) MPY: Compile & Run';
          compileStatusBarItem.color = 'lightblue';
          return;
        }

        // Відновлюємо вигляд кнопки
        compileStatusBarItem.text = '$(tools) MPY: Compile & Run';
        compileStatusBarItem.color = 'lightblue';

        // Крок 3: Запускаємо main
        await new Promise(resolve => setTimeout(resolve, 500));
        let debugTerminal = vscode.window.createTerminal('MPY Debugging');
        debugTerminal.show();

        vscode.window.showInformationMessage('Launching main (Запуск main)...');
        mpyOutputChannel.appendLine("🔹 Launching main...");

        openTerminalAndRunMain((usedPort === 'auto') ? 'auto' : formatPort(usedPort), debugTerminal);

        progress.report({ message: 'Done.' });
        mpyOutputChannel.appendLine("✅ Compile & Run completed.\n");
      } catch (error: any) {
        vscode.window.showErrorMessage(`Compile & Run failed (Сталася помилка): ${error}`);
        mpyOutputChannel.appendLine(`❌ Compile & Run failed: ${error.message}`);
      }
    });
  });
  context.subscriptions.push(disposableCompileAndRun);

  // ========= Додаємо кнопку "Save Project" =========
  let saveProjectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -3);
  saveProjectStatusBarItem.text = '$(archive) Save Project';
  saveProjectStatusBarItem.tooltip = 'Архівувати проект (папка src) / Archive project (src folder)';
  saveProjectStatusBarItem.color = 'yellow';
  saveProjectStatusBarItem.command = 'mpytools.saveProject';
  saveProjectStatusBarItem.show();
  context.subscriptions.push(saveProjectStatusBarItem);

  let disposableSaveProject = vscode.commands.registerCommand('mpytools.saveProject', async (): Promise<void> => {
    let workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('Не знайдено відкритий Workspace (No workspace).');
      return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const srcFolderPath = path.join(workspaceRoot, 'src');
    if (!fs.existsSync(srcFolderPath)) {
      vscode.window.showErrorMessage('Папка src не існує у Workspace (src folder does not exist).');
      return;
    }
    const saveFolderPath = path.join(workspaceRoot, '.save');
    if (!fs.existsSync(saveFolderPath)) {
      fs.mkdirSync(saveFolderPath);
    }

    const existingArchives = fs.readdirSync(saveFolderPath)
      .filter(file => /^v_\d+\.\d+\.\d+\.zip$/.test(file));

    let newVersion: string;
    try {
      if (existingArchives.length === 0) {
        newVersion = 'v_0.0.0';
      } else {
        newVersion = getNextVersion(existingArchives);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(error.message);
      return;
    }

    const archiveFileName = newVersion + '.zip';
    const archiveFilePath = path.join(saveFolderPath, archiveFileName);

    let archiveCommand = '';
    if (os.platform() === 'win32') {
      archiveCommand = `powershell -Command "Compress-Archive -Path '${srcFolderPath}' -DestinationPath '${archiveFilePath}'"`;
    } else {
      archiveCommand = `cd "${workspaceRoot}" && zip -r "${archiveFilePath}" "src"`;
    }

    mpyOutputChannel.appendLine(`🔹 Save Project -> creating archive: ${archiveFileName}`);

    try {
      await execPromise(archiveCommand);
      vscode.window.showInformationMessage(`Проект збережено (Project saved) як: ${archiveFileName}`);
      mpyOutputChannel.appendLine(`✅ Project archived as: ${archiveFileName}\n`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Помилка при архівації (Archive error): ${err.message}`);
      mpyOutputChannel.appendLine(`❌ Archive error: ${err.message}`);
    }
  });
  context.subscriptions.push(disposableSaveProject);
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

/**
 * Компілює один файл .py у .mpy (викликаючи `mpy-cross -O...`).
 */
async function compilePyFile(
  pyFilePath: string,
  srcPath: string,
  mpyPath: string
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const relative = path.relative(srcPath, pyFilePath);
    const outPath = path.join(mpyPath, relative.replace(/\.py$/, '.mpy'));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const cmd = `mpy-cross -O${selectedCompilationMethod} "${pyFilePath}" -o "${outPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (stdout && stdout.trim()) {
        console.log(`[mpy-cross stdout] ${stdout.trim()}`);
      }
      if (stderr && stderr.trim()) {
        console.error(`[mpy-cross stderr] ${stderr.trim()}`);
      }
      if (error) {
        reject(error);
      } else {
        resolve(outPath);
      }
    });
  });
}

/**
 * Відкриває термінал і виконує `mpremote connect <port> exec "import main" + repl`,
 * а потім через 2 секунди — викликає `main.run()`.
 */
function openTerminalAndRunMain(port: string, debugTerminal: vscode.Terminal): void {
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

/**
 * Виконує команду у shell і повертає Promise зі stdout або помилкою.
 */
function execPromise(command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      if (stderr && stderr.trim()) {
        // Якщо є stderr, теж віддаємо як помилку
        reject(new Error(stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Форматує порт залежно від платформи: COM4 -> COM4 (Windows),
 * /dev/ttyUSB0 -> /dev/ttyUSB0 (Linux/Mac).
 */
function formatPort(port: string): string {
  const platform = os.platform();
  if (platform === 'win32') {
    return port;
  } else if (platform === 'linux' || platform === 'darwin') {
    return `/dev/${port}`;
  }
  return port;
}

/**
 * Рекурсивно знаходить .py файли в директорії rootDir, ігноруючи імена з ignoreList.
 */
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

/**
 * Знаходить наступну версію архіву на основі існуючих назв (типу v_1.2.3.zip).
 */
function getNextVersion(existingArchives: string[]): string {
  let maxVersion = { major: 0, minor: 0, patch: 0 };
  for (const file of existingArchives) {
    const match = file.match(/^v_(\d+)\.(\d+)\.(\d+)\.zip$/);
    if (match) {
      const major = parseInt(match[1]);
      const minor = parseInt(match[2]);
      const patch = parseInt(match[3]);
      if (
        major > maxVersion.major ||
        (major === maxVersion.major && minor > maxVersion.minor) ||
        (major === maxVersion.major && minor === maxVersion.minor && patch > maxVersion.patch)
      ) {
        maxVersion = { major, minor, patch };
      }
    }
  }
  let { major, minor, patch } = maxVersion;
  patch++;
  if (patch >= 100) {
    patch = 0;
    minor++;
    if (minor >= 100) {
      minor = 0;
      major++;
      if (major >= 100) {
        throw new Error('Досягнуто максимальну версію архіву: v_99.99.99 (Maximum version reached)');
      }
    }
  }
  return `v_${major}.${minor}.${patch}`;
}

export function deactivate(): void {
  // Додаткові дії при деактивації, якщо потрібно.
}
