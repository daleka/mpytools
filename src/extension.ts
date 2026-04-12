// extension.ts
 
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { registerDependenciesCommand } from './dependenciesInstaller';
import { registerSaveProjectCommand } from './saveProject';
import { registerCompileAndRunCommand } from './compileAndRun';
import { registerFileManager } from './fileManager';
import { setSelectedPort as setSharedSelectedPort } from './sharedState';

// Вікно логу
export const mpyOutputChannel = vscode.window.createOutputChannel("MPyTools Log");

// Інформація про поточну прошивку/архітектуру
export let micropythonVersion: string | undefined = undefined;
export let micropythonBytecodeVersion: number | undefined = undefined;
export let micropythonArchitecture: string | undefined = undefined;
export let micropythonMsmallIntBits: number | undefined = undefined;

// (NEW!) Збережемо також sysname/release
export let micropythonSysName: string | undefined = undefined;
export let micropythonRelease: string | undefined = undefined;

// Останній вибраний порт
let lastUsedPort: string = 'auto';
// Обраний метод компіляції (наприклад -O0, -O1 тощо)
let selectedCompilationMethod: string | undefined = undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('MPyTools розширення активовано.');

  // 1. Реєструємо команду встановлення залежностей
  registerDependenciesCommand(context, mpyOutputChannel);
 
  // 1.5 Реєструємо команду збереження проекту
  registerSaveProjectCommand(context, mpyOutputChannel, execPromise);

  // Реєструємо менеджер файлів
  registerFileManager(context);

  // 2. Перевірка на встановлення mpremote тощо
  const packageJsonPath = context.asAbsolutePath('./package.json');
  const packageStats = fs.statSync(packageJsonPath);
  const currentInstallTime = packageStats.mtime.getTime();
  const storedInstallTime = context.globalState.get<number>('extensionInstallTime', 0);
  if (currentInstallTime > storedInstallTime) {
    context.globalState.update('extensionInstallTime', currentInstallTime);
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
  }

  // 3. Елементи статус-бару (Select Port, Run, Stop, нова кнопка "перл", Reset)
  let connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  connectionStatusBarItem.text = '$(plug) Select Port';
  connectionStatusBarItem.tooltip = 'Click to select a MicroPython port';
  connectionStatusBarItem.color = 'red';
  connectionStatusBarItem.command = 'mpytools.selectPort';
  connectionStatusBarItem.show();
  context.subscriptions.push(connectionStatusBarItem);

  // Кнопка Run
  let runStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  runStatusBarItem.text = '$(play) Run';
  runStatusBarItem.tooltip = 'Запустити активний файл';
  runStatusBarItem.command = 'mpytools.runActive';
  runStatusBarItem.hide();
  context.subscriptions.push(runStatusBarItem);

  // Кнопка Stop
  let stopStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  stopStatusBarItem.text = '$(debug-stop) Stop';
  stopStatusBarItem.tooltip = 'Зупинити виконання (Ctrl-C)';
  stopStatusBarItem.command = 'mpytools.stop';
  stopStatusBarItem.hide();
  context.subscriptions.push(stopStatusBarItem);

  // Нова кнопка "перл"
  let perlStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  perlStatusBarItem.text = '$(terminal) Perl';
  perlStatusBarItem.tooltip = 'Open REPL terminal (without running main.run())';
  perlStatusBarItem.command = 'mpytools.perl';
  perlStatusBarItem.hide();
  context.subscriptions.push(perlStatusBarItem);
  
  // Кнопка Reset
  let resetStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  resetStatusBarItem.text = '$(refresh) Reset';
  resetStatusBarItem.tooltip = 'Hard reset device';
  resetStatusBarItem.color = "#ff6666";
  resetStatusBarItem.command = 'mpytools.resetHard';
  resetStatusBarItem.hide();
  context.subscriptions.push(resetStatusBarItem);

  // --- Нова кнопка-настроек (gear) поруч із Save Project ---
  // Якщо Save Project створюється з пріоритетом -3, встановлюємо для кнопки-настроек пріоритет -4,
  // щоб вона була розташована праворуч від Save Project.
  let settingsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -4);
  settingsStatusBarItem.text = '$(gear)';
  settingsStatusBarItem.tooltip = 'MPyTools Settings';
  settingsStatusBarItem.command = 'mpytools.openSettings';
  settingsStatusBarItem.color = '#cccccc';
  settingsStatusBarItem.show();
  context.subscriptions.push(settingsStatusBarItem);

  // Реєструємо команду "mpytools.openSettings" для кнопки-настроек
  vscode.commands.registerCommand('mpytools.openSettings', async (): Promise<void> => {
    const options: vscode.QuickPickItem[] = [
      { label: 'Select Compilation Method', description: 'Re-select compilation method' },
      { label: 'Install Dependencies', description: 'Run dependency installation' }
    ];
    const selected = await vscode.window.showQuickPick(options, { placeHolder: 'Select an option' });
    if (!selected) {
      return;
    }
    if (selected.label === 'Select Compilation Method') {
      vscode.commands.executeCommand('mpytools.selectCompilationMethod');
    } else if (selected.label === 'Install Dependencies') {
      vscode.commands.executeCommand('mpytools.installDependencies');
    }
  });

  // Реєструємо команду "mpytools.selectCompilationMethod"
  vscode.commands.registerCommand('mpytools.selectCompilationMethod', async (): Promise<void> => {
    const compilationOptions: vscode.QuickPickItem[] = [
      { label: 'mpy-cross optimization Level 0', description: 'No optimization' },
      { label: 'mpy-cross optimization Level 1', description: 'Basic optimization' },
      { label: 'mpy-cross optimization Level 2', description: 'Medium optimization' },
      { label: 'mpy-cross optimization Level 3', description: 'Max optimization' },
      { label: 'No Compilation', description: 'Upload source files directly without compiling' }
    ];
    const result = await vscode.window.showQuickPick(compilationOptions, {
      placeHolder: 'Choose a compilation method',
      canPickMany: false
    });
    if (!result) {
      return;
    }
    if (result.label === 'No Compilation') {
      selectedCompilationMethod = 'none';
    } else {
      const match = result.label.match(/Level (\d+)/);
      selectedCompilationMethod = match ? match[1] : '0';
    }
    vscode.window.showInformationMessage(`Compilation method set to: ${selectedCompilationMethod === 'none' ? 'No Compilation' : 'Optimization O' + selectedCompilationMethod}`);
  });

  // --- Оновлений код вибору порту з асинхронним скануванням ---
  let disposableSelectPort = vscode.commands.registerCommand('mpytools.selectPort', async (): Promise<void> => {
    vscode.window.terminals
      .filter(t => t.name.startsWith("MPY"))
      .forEach(t => t.dispose());
    mpyOutputChannel.show(true);
    mpyOutputChannel.appendLine("=== Select Port command invoked ===");
    await new Promise(resolve => setTimeout(resolve, 300));
    connectionStatusBarItem.text = '$(sync~spin) Scanning ports...';
    connectionStatusBarItem.color = 'yellow';
    connectionStatusBarItem.tooltip = 'Scanning available ports...';
    let availablePorts: string[] = [];
    let portsError: string | null = null;
    try {
      const { ports, errorMsg } = await listRawPorts();
      if (errorMsg) {
        portsError = errorMsg;
      }
      availablePorts = ports;
    } catch (err: any) {
      portsError = err.message ?? String(err);
    }
    if (!availablePorts.includes('auto')) {
      availablePorts.push('auto');
    }
    if (portsError) {
      mpyOutputChannel.appendLine("❌ Error listing ports: " + portsError);
    }
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = `Select a port to use (current: ${lastUsedPort})`;
    quickPick.matchOnDescription = true;
    let items: vscode.QuickPickItem[] = availablePorts.map((p) => ({
      label: p,
      description: (p === 'auto') ? '(Automatic detection)' : '(No info yet...)'
    }));
    if (items.length === 0) {
      items.push({
        label: 'auto',
        description: '(No ports found...)'
      });
    }
    quickPick.items = items;
    let stopScanning = false;
    (async () => {
      for (let i = 0; i < items.length; i++) {
        if (stopScanning) { break; }
        let item = items[i];
        if (item.label === 'auto') { continue; }
        try {
          const deviceInfo = await tryGetDeviceInfo(item.label);
          if (stopScanning) { break; }
          if (deviceInfo) {
            let { sys, rel, mach } = deviceInfo;
            item.description = sys && rel && mach ? `(${sys} ${rel} ${mach})` : '(Micropython? unrecognized uname)';
          } else {
            item.description = '(Failed or not MicroPython)';
          }
        } catch (err: any) {
          item.description = `(Access error: ${err.message || err})`;
        }
        quickPick.items = [...items];
      }
    })();
    quickPick.onDidAccept(async () => {
      stopScanning = true;
      const chosen = quickPick.selectedItems[0];
      if (!chosen) {
        quickPick.hide();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      lastUsedPort = chosen.label;
      setSharedSelectedPort(lastUsedPort);
      mpyOutputChannel.appendLine(`▶️ Selected port: "${lastUsedPort}"`);
      connectionStatusBarItem.text = '$(sync~spin) MPY: Connecting...';
      connectionStatusBarItem.color = 'yellow';
      connectionStatusBarItem.tooltip = 'Connecting to the device...';
      vscode.window.terminals
        .filter(t => t.name.startsWith("MPY"))
        .forEach(t => t.dispose());
      await new Promise(resolve => setTimeout(resolve, 2000));
      const usedPort = (lastUsedPort === 'auto') ? 'auto' : formatPort(lastUsedPort);
      mpyOutputChannel.show(true);
      mpyOutputChannel.appendLine(`⚙️ Fetching device info (version, architecture, small-int bits)...`);
      mpyOutputChannel.appendLine(`⚙️ mpremote connect ${usedPort} exec "import sys; ..."`);
      let fetchError: any = null;
      try {
        await fetchMicropythonVersionInfo(usedPort);
      } catch (err) {
        fetchError = err;
      }
      vscode.commands.executeCommand('mpytoolsFileExplorer.refresh');
      if (!fetchError) {
        mpyOutputChannel.appendLine(`✅ Connected to port: "${lastUsedPort}"`);
        mpyOutputChannel.appendLine("✅ Fetched device info successfully.");
        mpyOutputChannel.appendLine("");
        compileStatusBarItem.show();
        runStatusBarItem.show();
        stopStatusBarItem.show();
        perlStatusBarItem.show();
        resetStatusBarItem.show();
        connectionStatusBarItem.text = `$(check) ${micropythonSysName ?? '???'} ${micropythonRelease ?? ''} ${lastUsedPort}`;
        connectionStatusBarItem.color = 'green';
        connectionStatusBarItem.tooltip = 'Port selected';
      } else {
        mpyOutputChannel.appendLine(`⚠️ Could not fetch MicroPython info: ${fetchError}`);
        mpyOutputChannel.appendLine("");
      }
      removeMpyFolder();
      await new Promise(resolve => setTimeout(resolve, 300));
      let connectTerminal = vscode.window.createTerminal('MPY Session');
      connectTerminal.sendText(
        `mpremote connect ${usedPort} exec "import os, gc; print(os.uname()); print('Free memory:', gc.mem_free())" + repl`
      );
      setTimeout(() => {
        connectTerminal.show();
      }, 1500);
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      stopScanning = true;
    });
    quickPick.show();
  });
  context.subscriptions.push(disposableSelectPort);
  // --- Кінець оновленого коду вибору порту ---

  // Реєструємо команду "mpytools.perl" для кнопки "перл"
  vscode.commands.registerCommand('mpytools.perl', async (): Promise<void> => {
    vscode.window.terminals
      .filter(t => t.name.startsWith("MPY"))
      .forEach(t => t.dispose());
    const usedPort = (lastUsedPort === 'auto') ? 'auto' : formatPort(lastUsedPort);
    let perlTerminal = vscode.window.createTerminal('MPY Perl');
    perlTerminal.show();
    perlTerminal.sendText(`mpremote connect ${usedPort} repl`);
  });

  // Команда "Run Active"
  vscode.commands.registerCommand('mpytools.runActive', async (): Promise<void> => {
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
    mpyOutputChannel.appendLine("▶️ Run active file: " + filePath);
    let runTerminal = vscode.window.createTerminal('MPY Run');
    runTerminal.show();
    runTerminal.sendText(`mpremote run "${filePath}"`);
  });

  // Команда "Stop"
  vscode.commands.registerCommand('mpytools.stop', async (): Promise<void> => {
    const terminal = vscode.window.activeTerminal;
    if (terminal) {
      terminal.sendText("\x03", false);
      vscode.window.showInformationMessage("Stop: Ctrl-C відправлено. (Execution stopped)");
      mpyOutputChannel.appendLine("✋ Stop signal (Ctrl-C) sent.");
    } else {
      vscode.window.showWarningMessage("Немає активного термінала для зупинки.");
    }
  });

  // Команда "Reset Hard"
  vscode.commands.registerCommand('mpytools.resetHard', async (): Promise<void> => {
    try {
      const terminalsToClose = vscode.window.terminals.filter(t =>
        t.name.startsWith("MPY")
      );
      terminalsToClose.forEach(t => t.dispose());
      const usedPort = (lastUsedPort === 'auto') ? 'auto' : formatPort(lastUsedPort);
      mpyOutputChannel.appendLine(`🔧 Hard Reset on port "${lastUsedPort}"`);
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

  // Реєструємо "Compile & Run"
  const compileStatusBarItem = registerCompileAndRunCommand(
    context,
    mpyOutputChannel,
    execPromise,
    () => lastUsedPort,
    () => selectedCompilationMethod,
    (val: string | undefined) => { selectedCompilationMethod = val; },
    needsRecompile,
    compilePyFile,
    findPyFiles,
    openTerminalAndRunMain,
    formatPort,
    () => micropythonVersion,
    () => micropythonBytecodeVersion,
    () => micropythonArchitecture,
    () => micropythonMsmallIntBits
  );
} // Кінець activate

/**
 * Швидка функція: отримаємо сирі порти з `mpremote connect list`.
 */
async function listRawPorts(): Promise<{ ports: string[]; errorMsg?: string }> {
  return new Promise((resolve) => {
    exec('mpremote connect list', (error, stdout, stderr) => {
      if (error || stderr) {
        resolve({
          ports: [],
          errorMsg: error?.message || stderr
        });
        return;
      }
      const lines = stdout.split('\n');
      const allPorts: string[] = lines
        .filter((line) => line.includes('COM') || line.includes('/dev/'))
        .map((line) => line.trim().split(' ')[0])
        .filter(Boolean);
      resolve({
        ports: allPorts
      });
    });
  });
}

/**
 * Спроба отримати uname з порту: `mpremote connect <port> exec "import os; print(os.uname())"`.
 */
async function tryGetDeviceInfo(port: string): Promise<{ sys: string; rel: string; mach: string } | null> {
  const cmd = `mpremote connect ${port} exec "import os; print(os.uname())"`;
  mpyOutputChannel.appendLine(`   🔎 Checking port: ${port} -> ${cmd}`);
  try {
    const deviceInfo = await execPromise(cmd);
    let sysMatch = deviceInfo.match(/sysname='([^']+)'/);
    let relMatch = deviceInfo.match(/release='([^']+)'/);
    let machMatch = deviceInfo.match(/machine='([^']+)'/);
    let sys = sysMatch ? sysMatch[1] : '';
    let rel = relMatch ? relMatch[1] : '';
    let mach = machMatch ? machMatch[1] : '';
    if (!sys) { return null; }
    return { sys, rel, mach };
  } catch (err) {
    return null;
  }
}

/**
 * Отримати інформацію (версія, архітектура, ...).
 */
async function fetchMicropythonVersionInfo(port: string): Promise<void> {
  const cmd = `mpremote connect ${port} exec "` +
    `import sys, os; ` +
    `print('MPYVER:', sys.implementation.version); ` +
    `print('MPYCODE:', sys.implementation._mpy); ` +
    `arch_val = (sys.implementation._mpy >> 10); print('MPYARCH:', arch_val); ` +
    `print('MAXSIZE:', sys.maxsize); ` +
    `u=os.uname(); ` +
    `print('SYSNAME:', u.sysname); ` +
    `print('RELEASE:', u.release); ` +
    `"`;
  mpyOutputChannel.appendLine(`🔍 Fetching MicroPython info via: ${cmd}`);

  return new Promise<void>((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        mpyOutputChannel.appendLine("❌ Error running fetchMicropythonVersionInfo: " + error);
        return reject(error);
      }
      if (stderr && stderr.trim()) {
        mpyOutputChannel.appendLine("⚠️ Stderr in fetchMicropythonVersionInfo: " + stderr.trim());
      }

      const archMap: Record<number, string> = {
        1: 'x86',
        2: 'x64',
        3: 'armv6',
        4: 'armv6m',
        5: 'armv7m',
        6: 'armv7em',
        7: 'armv7emsp',
        8: 'armv7emdp',
        9: 'xtensa',
        10: 'xtensawin',
        11: 'rv32imc'
      };

      function interpretMsmallIntBits(value: number): number | undefined {
        if (value === 2147483647) {
          return 31;
        }
        if (value === 9223372036854775807) {
          return 63;
        }
        if (value === 32767) {
          return 15;
        }
        return undefined;
      }

      let sysVal = 'unknown';
      let relVal = 'unknown';

      const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith("MPYVER:")) {
          micropythonVersion = line.replace("MPYVER:", "").trim();
          mpyOutputChannel.appendLine(`📌 micropythonVersion = ${micropythonVersion || 'none'}`);
        } else if (line.startsWith("MPYCODE:")) {
          let codeNum = parseInt(line.replace("MPYCODE:", "").trim(), 10);
          if (isNaN(codeNum)) { codeNum = -1; }
          micropythonBytecodeVersion = codeNum >= 0 ? codeNum : undefined;
          mpyOutputChannel.appendLine(`📌 micropythonBytecodeVersion = ${micropythonBytecodeVersion ?? 'none'}`);
        } else if (line.startsWith("MPYARCH:")) {
          const archNum = parseInt(line.replace("MPYARCH:", "").trim(), 10);
          micropythonArchitecture = archMap[archNum] ?? undefined;
          mpyOutputChannel.appendLine(`📌 micropythonArchitecture = ${micropythonArchitecture || 'none'}`);
        } else if (line.startsWith("MAXSIZE:")) {
          const maxsizeNum = parseInt(line.replace("MAXSIZE:", "").trim(), 10);
          micropythonMsmallIntBits = !isNaN(maxsizeNum) ? interpretMsmallIntBits(maxsizeNum) : undefined;
          mpyOutputChannel.appendLine(`📌 micropythonMsmallIntBits = ${micropythonMsmallIntBits ?? 'none'}`);
        } else if (line.startsWith("SYSNAME:")) {
          sysVal = line.replace("SYSNAME:", "").trim();
          mpyOutputChannel.appendLine(`📌 sysname = ${sysVal}`);
        } else if (line.startsWith("RELEASE:")) {
          relVal = line.replace("RELEASE:", "").trim();
          mpyOutputChannel.appendLine(`📌 release = ${relVal}`);
        }
      }

      micropythonSysName = sysVal;
      micropythonRelease = relVal;

      resolve();
    });
  });
}

/**
 * Виконати exec з Promise
 */
export function execPromise(command: string): Promise<string> {
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

/**
 * Прибираємо папку mpy (якщо існує)
 */
function removeMpyFolder(): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const mpyPath = path.join(workspaceRoot, 'mpy');

  if (!fs.existsSync(mpyPath)) {
    return;
  }

  mpyOutputChannel.appendLine("🗑 Removing 'mpy' folder from the project...");
  removeFolderRecursive(mpyPath);
  mpyOutputChannel.appendLine("✅ 'mpy' folder removed successfully.");
  mpyOutputChannel.appendLine("");
}

function removeFolderRecursive(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file) => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        removeFolderRecursive(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}

/**
 * Формат порту (Windows vs Linux)
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
 * Перевірка часу змін .py vs .mpy
 */
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
 * Компіляція .py у .mpy
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

    const archFlag = micropythonArchitecture ? `-march=${micropythonArchitecture}` : '';
    const smallIntFlag = micropythonMsmallIntBits ? `-msmall-int-bits=${micropythonMsmallIntBits}` : '';
    const optimizationFlag = selectedCompilationMethod ? `-O${selectedCompilationMethod}` : '';

    const bytecodeVersion = getSupportedBytecodeVersion(micropythonVersion);
    let versionFlag = '';
    if (bytecodeVersion !== undefined) {
      versionFlag = `-b ${bytecodeVersion}`;
    } else {
      mpyOutputChannel.appendLine("⚠️ Warning: Bytecode not supported for this version of MicroPython. Skipping -b flag.");
    }

    const cmd = `mpy-cross ${archFlag} ${smallIntFlag} ${optimizationFlag} ${versionFlag} "${pyFilePath}" -o "${outPath}"`
      .replace(/\s+/g, ' ')
      .trim();

    mpyOutputChannel.appendLine(`⚙️ Running mpy-cross command: ${cmd}`);
    if (!micropythonArchitecture) {
      mpyOutputChannel.appendLine("⚠️ Warning: micropythonArchitecture not obtained. Omitting -march flag.");
    }
    if (!micropythonMsmallIntBits) {
      mpyOutputChannel.appendLine("⚠️ Warning: micropythonMsmallIntBits not obtained. Omitting -msmall-int-bits flag.");
    }

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
 * Запуск main.run() через mpremote
 */
async function openTerminalAndRunMain(port: string, debugTerminal: vscode.Terminal): Promise<void> {
  const connectTarget = port === 'auto' ? 'auto' : port;
  mpyOutputChannel.appendLine(`⚙️ Opening REPL on port: ${connectTarget}`);
  debugTerminal.sendText(`mpremote connect ${connectTarget} repl`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  mpyOutputChannel.appendLine(`⚙️ Running main.run() from REPL on port: ${connectTarget}`);
  debugTerminal.sendText('import main; main.run()');
}

/**
 * Знаходимо всі .py файли рекурсево
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
 * Вирахувати підтримувану версію .mpy байткоду
 */
function parseVersion(version: string): number[] {
  const nums = version.match(/\d+/g);
  if (!nums) {
    return [];
  }
  return nums.slice(0, 3).map(Number);
}

function compareVersions(v1: number[], v2: number[]): number {
  const len = Math.max(v1.length, v2.length);
  for (let i = 0; i < len; i++) {
    const a = v1[i] || 0;
    const b = v2[i] || 0;
    if (a > b) {
      return 1;
    }
    if (a < b) {
      return -1;
    }
  }
  return 0;
}

/**
 * Яку версію _mpy підставляти?
 */
function getSupportedBytecodeVersion(micropythonVersion: string | undefined): number | undefined {
  if (!micropythonVersion) {
    return undefined;
  }
  const ver = parseVersion(micropythonVersion);
  if (ver.length < 3) {
    return undefined;
  }
  const v112 = [1, 12, 0];
  const v119 = [1, 19, 0];
  const v120 = [1, 20, 0];
  const v123 = [1, 23, 0];

  if (compareVersions(ver, v112) >= 0 && compareVersions(ver, v119) < 0) {
    return 5;
  } else if (compareVersions(ver, v119) >= 0 && compareVersions(ver, v120) < 0) {
    return 6;
  } else if (compareVersions(ver, v120) >= 0 && compareVersions(ver, v123) < 0) {
    return 6.1;
  } else if (compareVersions(ver, v123) >= 0) {
    return 6.3;
  }
  return undefined;
}

/**
 * Деактивуємо
 */
export function deactivate(): void {
  // ...
}
