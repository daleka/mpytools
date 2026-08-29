// extension.ts
 
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { registerDependenciesCommand } from './dependenciesInstaller';
import { registerSaveProjectCommand } from './saveProject';
import { registerCompileAndRunCommand } from './compileAndRun';
import { registerFileManager } from './fileManager';
import { formatMpyCrossInvocation, runMpyCross } from './mpyCross';
import { ToolchainManager } from './toolchain';
import { BufferedOutputChannel } from './bufferedOutputChannel';
import { MpremoteService } from './mpremoteService';
import { DeviceSession } from './deviceSession';
import { describePort, SerialPortDescriptor } from './ports';
import { decodeMpyAbi } from './micropythonInfo';
import {
  BuildOutputLocation,
  BuildStoragePaths,
  clearBuildStorage,
  resolveBuildStoragePaths
} from './buildWorkspace';
import { resolveWorkspaceProjectFolder } from './workspaceProject';

// Вікно логу
export const mpyOutputChannel = new BufferedOutputChannel(
  vscode.window.createOutputChannel("MPyTools Log"),
  150
);

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
  context.subscriptions.push(mpyOutputChannel);
  const compileMethodSettingKey = 'mpytools.compileMethod';
  const wrapNonPySettingKey = 'mpytools.wrapNonPyFiles';
  const compileSettingsDirtyKey = 'mpytools.compileSettingsDirty';

  const buildStorageForFolder = (folder: vscode.WorkspaceFolder): BuildStoragePaths => {
    const location = vscode.workspace
      .getConfiguration('mpytools', folder.uri)
      .get<BuildOutputLocation>('buildOutputLocation', 'workspace');
    return resolveBuildStoragePaths(
      folder.uri.fsPath,
      context.storageUri?.fsPath,
      context.globalStorageUri.fsPath,
      location
    );
  };

  const resolveProjectBuildStorage = async (
    placeHolder: string
  ): Promise<{ folder: vscode.WorkspaceFolder; storage: BuildStoragePaths } | undefined> => {
    const folder = await resolveWorkspaceProjectFolder(placeHolder);
    if (!folder) {
      vscode.window.showWarningMessage('No MPyTools project workspace selected.');
      return undefined;
    }
    return { folder, storage: buildStorageForFolder(folder) };
  };

  const unambiguousProjectFolder = (): vscode.WorkspaceFolder | undefined => {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder) {
      return activeFolder;
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 ? folders[0] : undefined;
  };

  const toolchain = new ToolchainManager(context, mpyOutputChannel);
  const mpremote = new MpremoteService(toolchain, (line) => mpyOutputChannel.appendLine(line));
  const deviceSession = new DeviceSession(context, mpremote);
  context.subscriptions.push(deviceSession);
  lastUsedPort = deviceSession.currentPort();

  // 1. Реєструємо команду ізольованого встановлення залежностей
  registerDependenciesCommand(context, mpyOutputChannel, toolchain);
 
  // 1.5 Реєструємо команду збереження проекту
  registerSaveProjectCommand(context, mpyOutputChannel);

  // Реєструємо менеджер файлів
  registerFileManager(context, deviceSession);

  // 2. Перевіряємо реальний стан інструментів, а не час перевстановлення VSIX.
  void toolchain.health().then((health) => {
    if (!health.mpremote || !health.mpyCrossAvailable) {
      const missing = [!health.mpremote && 'mpremote', !health.mpyCrossAvailable && 'mpy-cross']
        .filter(Boolean)
        .join(', ');
      void vscode.window.showInformationMessage(
        `MPyTools is missing: ${missing}. Install an isolated toolchain?`,
        'Install'
      ).then((choice) => {
        if (choice === 'Install') {
          void vscode.commands.executeCommand('mpytools.installDependencies');
        }
      });
    }
  });

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

  // Кнопка REPL
  let perlStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
  perlStatusBarItem.text = '$(terminal) REPL';
  perlStatusBarItem.tooltip = 'Open an interactive MicroPython REPL terminal';
  perlStatusBarItem.command = 'mpytools.repl';
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
  context.subscriptions.push(vscode.commands.registerCommand('mpytools.openSettings', async (): Promise<void> => {
    const wrapEnabled = context.workspaceState.get<boolean>(wrapNonPySettingKey);
    const options: vscode.QuickPickItem[] = [
      { label: 'Select Compilation Method', description: 'Re-select compilation method' },
      { label: 'Compile non-.py files (ON/OFF)', description: `Current: ${wrapEnabled === false ? 'OFF' : 'ON'}` },
      { label: 'Install Toolchain', description: 'Install isolated mpremote and mpy-cross' },
      { label: 'Install Stubs', description: 'Install project-local MicroPython stubs' },
      { label: 'Build Folder Location', description: 'Choose visible workspace mpy/ or protected extension storage' },
      { label: 'Open Build Folder', description: 'Open the current generated upload folder' },
      { label: 'Clear Build Cache', description: 'Delete generated build files safely' },
      { label: 'Diagnostics', description: 'Inspect toolchain, serial ports and device access' }
    ];
    const selected = await vscode.window.showQuickPick(options, { placeHolder: 'Select an option' });
    if (!selected) {
      return;
    }
    if (selected.label === 'Select Compilation Method') {
      vscode.commands.executeCommand('mpytools.selectCompilationMethod');
    } else if (selected.label === 'Compile non-.py files (ON/OFF)') {
      vscode.commands.executeCommand('mpytools.selectNonPyCompilationMode');
    } else if (selected.label === 'Install Toolchain') {
      vscode.commands.executeCommand('mpytools.installDependencies');
    } else if (selected.label === 'Install Stubs') {
      vscode.commands.executeCommand('mpytools.installStubs');
    } else if (selected.label === 'Build Folder Location') {
      vscode.commands.executeCommand('mpytools.selectBuildOutputLocation');
    } else if (selected.label === 'Open Build Folder') {
      vscode.commands.executeCommand('mpytools.openBuildOutput');
    } else if (selected.label === 'Clear Build Cache') {
      vscode.commands.executeCommand('mpytools.clearBuildCache');
    } else if (selected.label === 'Diagnostics') {
      vscode.commands.executeCommand('mpytools.diagnostics');
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('mpytools.selectBuildOutputLocation', async (): Promise<void> => {
    const resolved = await resolveProjectBuildStorage('Select the project whose MPyTools build folder should change');
    if (!resolved) {
      return;
    }
    interface BuildLocationPick extends vscode.QuickPickItem {
      value: BuildOutputLocation;
    }
    const currentLocation = resolved.storage.location;
    const selected = await vscode.window.showQuickPick<BuildLocationPick>([
      {
        label: 'Visible workspace mpy/ folder',
        description: currentLocation === 'workspace' ? 'Current' : 'Easy to inspect and delete manually',
        detail: 'MPyTools owns <project>/mpy and removes stale files from it before upload.',
        value: 'workspace'
      },
      {
        label: 'Protected extension storage',
        description: currentLocation === 'extensionStorage' ? 'Current' : 'Reduces workspace file watching',
        detail: 'Generated files stay outside the project but can be opened with MPY: Open Build Folder.',
        value: 'extensionStorage'
      }
    ], { placeHolder: 'Choose where MPyTools stores generated upload files' });
    if (!selected || selected.value === currentLocation) {
      return;
    }

    if (selected.value === 'workspace') {
      const confirmation = await vscode.window.showWarningMessage(
        `MPyTools will own and may fully delete ${path.join(resolved.folder.uri.fsPath, 'mpy')}. Continue?`,
        { modal: true },
        'Use workspace mpy/'
      );
      if (confirmation !== 'Use workspace mpy/') {
        return;
      }
    }

    const destination = resolveBuildStoragePaths(
      resolved.folder.uri.fsPath,
      context.storageUri?.fsPath,
      context.globalStorageUri.fsPath,
      selected.value
    );
    await clearBuildStorage(resolved.storage);
    await clearBuildStorage(destination);
    await vscode.workspace
      .getConfiguration('mpytools', resolved.folder.uri)
      .update('buildOutputLocation', selected.value, vscode.ConfigurationTarget.WorkspaceFolder);
    await fs.promises.mkdir(destination.build, { recursive: true });
    mpyOutputChannel.appendLine(`✅ Build output location: ${destination.build}`);
    vscode.window.showInformationMessage(
      selected.value === 'workspace'
        ? 'MPyTools will now build into the visible project mpy/ folder.'
        : 'MPyTools will now build in protected VS Code extension storage.'
    );
  }));

  context.subscriptions.push(vscode.commands.registerCommand('mpytools.openBuildOutput', async (): Promise<void> => {
    const resolved = await resolveProjectBuildStorage('Select the project whose MPyTools build folder should open');
    if (!resolved) {
      return;
    }
    await fs.promises.mkdir(resolved.storage.build, { recursive: true });
    mpyOutputChannel.appendLine(`📂 Build output: ${resolved.storage.build}`);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolved.storage.build));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('mpytools.clearBuildCache', async (): Promise<void> => {
    const resolved = await resolveProjectBuildStorage('Select the project whose MPyTools build cache should be cleared');
    if (!resolved) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Delete MPyTools generated files for ${resolved.folder.name}?\n${resolved.storage.build}`,
      { modal: true },
      'Clear Build Cache'
    );
    if (confirmation !== 'Clear Build Cache') {
      return;
    }
    await clearBuildStorage(resolved.storage);
    mpyOutputChannel.appendLine(`🗑 Cleared build cache: ${resolved.storage.build}`);
    vscode.window.showInformationMessage('MPyTools build cache cleared. The next build will recreate it.');
  }));

  // Реєструємо команду "mpytools.selectCompilationMethod"
  context.subscriptions.push(vscode.commands.registerCommand('mpytools.selectCompilationMethod', async (): Promise<void> => {
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
    await context.workspaceState.update(compileMethodSettingKey, selectedCompilationMethod);
    await context.workspaceState.update(compileSettingsDirtyKey, false);
    vscode.window.showInformationMessage(`Compilation method set to: ${selectedCompilationMethod === 'none' ? 'No Compilation' : 'Optimization O' + selectedCompilationMethod}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('mpytools.selectNonPyCompilationMode', async (): Promise<void> => {
    const options: vscode.QuickPickItem[] = [
      {
        label: 'ON — Compile non-.py files',
        description: 'Wrap common files (e.g. .html, .js, .css, .json, .txt) into .py and compile/upload'
      },
      {
        label: 'OFF — Do not compile non-.py files',
        description: 'Keep non-.py files as-is and upload them without wrapping/compiling'
      }
    ];
    const result = await vscode.window.showQuickPick(options, {
      placeHolder: 'Choose non-.py handling mode',
      canPickMany: false
    });
    if (!result) {
      return;
    }
    const shouldWrapNonPy = result.label === 'ON — Compile non-.py files';
    await context.workspaceState.update(wrapNonPySettingKey, shouldWrapNonPy);
    await context.workspaceState.update(compileSettingsDirtyKey, false);
    vscode.window.showInformationMessage(`Compile non-.py files: ${shouldWrapNonPy ? 'ON' : 'OFF'}`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('mpytools.diagnostics', async (): Promise<void> => {
    mpyOutputChannel.clear();
    mpyOutputChannel.show(true);
    mpyOutputChannel.appendLine('=== MPyTools Diagnostics ===');
    mpyOutputChannel.appendLine(`Host: ${process.platform} ${process.arch}`);
    mpyOutputChannel.appendLine(`VS Code environment: ${vscode.env.remoteName ?? 'local'}`);
    mpyOutputChannel.appendLine(`Selected port: ${deviceSession.currentPort()}`);
    if (process.platform !== 'win32') {
      mpyOutputChannel.appendLine(`UID/GID: ${process.getuid?.() ?? 'n/a'}/${process.getgid?.() ?? 'n/a'}`);
      mpyOutputChannel.appendLine(`Supplementary groups: ${process.getgroups?.().join(', ') ?? 'n/a'}`);
    }
    const health = await toolchain.health();
    if (health.mpremote) {
      mpyOutputChannel.appendLine(
        `mpremote: ${health.mpremote.executable} (${health.mpremote.source})`
      );
    } else {
      mpyOutputChannel.appendLine('mpremote: MISSING');
    }
    mpyOutputChannel.appendLine(`mpy-cross: ${health.mpyCrossAvailable ? 'available' : 'MISSING'}`);
    try {
      const ports = await mpremote.listPorts();
      mpyOutputChannel.appendLine(`Serial ports (${ports.length}):`);
      for (const port of ports) {
        mpyOutputChannel.appendLine(`  ${port.path}  ${describePort(port)}`);
      }
    } catch (error: any) {
      mpyOutputChannel.appendLine(`Port discovery failed: ${error.message}`);
    }
    const selectedPath = deviceSession.currentPort();
    if (selectedPath.startsWith('/')) {
      try {
        const stat = fs.statSync(selectedPath);
        fs.accessSync(selectedPath, fs.constants.R_OK | fs.constants.W_OK);
        mpyOutputChannel.appendLine(
          `Port access: read/write OK, mode=${(stat.mode & 0o777).toString(8)}, uid=${stat.uid}, gid=${stat.gid}`
        );
      } catch (error: any) {
        mpyOutputChannel.appendLine(`Port access failed: ${error.code ?? ''} ${error.message}`);
      }
    }
    try {
      const result = await deviceSession.run([
        'exec',
        "import os; print('DEVICE:', os.uname())"
      ], { timeoutMs: 15_000 });
      mpyOutputChannel.appendLine(result.stdout.trim());
      mpyOutputChannel.appendLine('✅ Device connection successful.');
    } catch (error: any) {
      mpyOutputChannel.appendLine(`❌ Device connection failed: ${error.kind ?? 'unknown'}: ${error.message}`);
    }
  }));

  // Вибір порту: mpremote вже повертає повні системні шляхи, тому не додаємо /dev повторно.
  let disposableSelectPort = vscode.commands.registerCommand('mpytools.selectPort', async (): Promise<void> => {
    await context.workspaceState.update(compileSettingsDirtyKey, true);
    await deviceSession.closeInteractiveTerminal();
    mpyOutputChannel.show(true);
    mpyOutputChannel.appendLine("=== Select Port command invoked ===");
    connectionStatusBarItem.text = '$(sync~spin) Scanning ports...';
    connectionStatusBarItem.color = 'yellow';
    connectionStatusBarItem.tooltip = 'Scanning available ports...';
    let availablePorts: SerialPortDescriptor[] = [];
    try {
      availablePorts = await mpremote.listPorts();
    } catch (err: any) {
      mpyOutputChannel.appendLine("❌ Error listing ports: " + (err.message ?? String(err)));
    }
    interface PortPickItem extends vscode.QuickPickItem {
      descriptor?: SerialPortDescriptor;
    }
    const quickPick = vscode.window.createQuickPick<PortPickItem>();
    quickPick.placeholder = `Select a port to use (current: ${lastUsedPort})`;
    quickPick.matchOnDescription = true;
    const items: PortPickItem[] = availablePorts.map((port) => ({
      label: port.path,
      description: describePort(port) || 'Serial port',
      descriptor: port
    }));
    items.push({ label: 'auto', description: 'Automatic MicroPython detection' });
    quickPick.items = items;
    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.onDidAccept(async () => {
      const chosen = quickPick.selectedItems[0];
      if (!chosen) {
        quickPick.hide();
        return;
      }
      compileStatusBarItem.hide();
      runStatusBarItem.hide();
      stopStatusBarItem.hide();
      perlStatusBarItem.hide();
      resetStatusBarItem.hide();
      try {
        await deviceSession.select(chosen.descriptor);
        lastUsedPort = deviceSession.currentPort();
        mpyOutputChannel.appendLine(`▶️ Selected port: "${lastUsedPort}"`);
        connectionStatusBarItem.text = '$(sync~spin) MPY: Connecting...';
        connectionStatusBarItem.color = 'yellow';
        connectionStatusBarItem.tooltip = 'Connecting to the device...';
        mpyOutputChannel.show(true);
        mpyOutputChannel.appendLine('⚙️ Fetching device info (version, architecture, small-int bits)...');
        await fetchMicropythonVersionInfo(deviceSession);
        const projectFolder = unambiguousProjectFolder();
        if (projectFolder) {
          try {
            const storage = buildStorageForFolder(projectFolder);
            await clearBuildStorage(storage);
            mpyOutputChannel.appendLine(`🗑 Reset build cache after port selection: ${storage.build}`);
          } catch (error: any) {
            mpyOutputChannel.appendLine(`⚠️ Could not reset build cache: ${error.message ?? error}`);
          }
        } else {
          mpyOutputChannel.appendLine('ℹ️ Build cache will reset when a project is selected for Compile & Run.');
        }
        await vscode.commands.executeCommand('mpytoolsFileExplorer.refresh');
        mpyOutputChannel.appendLine(`✅ Connected to port: "${lastUsedPort}"`);
        mpyOutputChannel.appendLine("✅ Fetched device info successfully.\n");
        compileStatusBarItem.show();
        runStatusBarItem.show();
        stopStatusBarItem.show();
        perlStatusBarItem.show();
        resetStatusBarItem.show();
        connectionStatusBarItem.text = `$(check) ${micropythonSysName ?? '???'} ${micropythonRelease ?? ''} ${lastUsedPort}`;
        connectionStatusBarItem.color = 'green';
        connectionStatusBarItem.tooltip = 'Port selected';
      } catch (error: any) {
        mpyOutputChannel.appendLine(`⚠️ Could not fetch MicroPython info: ${error.message ?? error}`);
        connectionStatusBarItem.text = `$(error) ${lastUsedPort}`;
        connectionStatusBarItem.color = 'red';
        connectionStatusBarItem.tooltip = error.message ?? String(error);
      } finally {
        quickPick.hide();
      }
    });
    quickPick.show();
  });
  context.subscriptions.push(disposableSelectPort);

  const openRepl = async (): Promise<void> => {
    await deviceSession.openRepl('MPY REPL');
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytools.connect', openRepl),
    vscode.commands.registerCommand('mpytools.repl', openRepl),
    vscode.commands.registerCommand('mpytools.perl', openRepl)
  );

  // Команда "Run Active"
  context.subscriptions.push(vscode.commands.registerCommand('mpytools.runActive', async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Немає активного файлу для запуску.");
      return;
    }
    const filePath = editor.document.uri.fsPath;
    mpyOutputChannel.appendLine("▶️ Run active file: " + filePath);
    await deviceSession.openRunFile(filePath);
  }));

  // Команда "Stop"
  context.subscriptions.push(vscode.commands.registerCommand('mpytools.stop', async (): Promise<void> => {
    if (deviceSession.stopInteractive()) {
      vscode.window.showInformationMessage("Stop: Ctrl-C відправлено. (Execution stopped)");
      mpyOutputChannel.appendLine("✋ Stop signal (Ctrl-C) sent.");
    } else {
      vscode.window.showWarningMessage("Немає активного термінала для зупинки.");
    }
  }));

  // Команда "Reset Hard"
  context.subscriptions.push(vscode.commands.registerCommand('mpytools.resetHard', async (): Promise<void> => {
    try {
      mpyOutputChannel.appendLine(`🔧 Hard Reset on port "${lastUsedPort}"`);
      await deviceSession.run(['reset']);
      vscode.window.showInformationMessage(`Device hard-reset requested on port "${lastUsedPort}"`);
      mpyOutputChannel.appendLine("✅ Hard reset command sent.");
    } catch (err: any) {
      vscode.window.showErrorMessage("Failed to reset (hard-reset) device: " + err);
      mpyOutputChannel.appendLine("❌ Error resetting device: " + err.message);
    }
  }));

  // Реєструємо "Compile & Run"
  const compileStatusBarItem = registerCompileAndRunCommand(
    context,
    mpyOutputChannel,
    deviceSession,
    () => selectedCompilationMethod,
    (val: string | undefined) => { selectedCompilationMethod = val; },
    needsRecompile,
    compilePyFile,
    compileFileToOutput,
    () => ({
      bytecodeVersion: micropythonBytecodeVersion,
      architecture: micropythonArchitecture,
      smallIntBits: micropythonMsmallIntBits
    })
  );

  void deviceSession.restore().then(async (restored) => {
    if (!restored) {
      return;
    }
    lastUsedPort = deviceSession.currentPort();
    try {
      await fetchMicropythonVersionInfo(deviceSession);
      compileStatusBarItem.show();
      runStatusBarItem.show();
      stopStatusBarItem.show();
      perlStatusBarItem.show();
      resetStatusBarItem.show();
      connectionStatusBarItem.text = `$(check) ${micropythonSysName ?? 'MicroPython'} ${lastUsedPort}`;
      connectionStatusBarItem.color = 'green';
      connectionStatusBarItem.tooltip = `Restored ${describePort(restored) || restored.path}`;
      void vscode.commands.executeCommand('mpytoolsFileExplorer.refresh');
    } catch (error: any) {
      connectionStatusBarItem.text = `$(warning) ${lastUsedPort}`;
      connectionStatusBarItem.color = 'yellow';
      connectionStatusBarItem.tooltip = `Saved device is unavailable: ${error.message}`;
    }
  });
} // Кінець activate

/**
 * Отримати інформацію (версія, архітектура, ...).
 */
async function fetchMicropythonVersionInfo(deviceSession: DeviceSession): Promise<void> {
  micropythonVersion = undefined;
  micropythonBytecodeVersion = undefined;
  micropythonArchitecture = undefined;
  micropythonMsmallIntBits = undefined;
  micropythonSysName = undefined;
  micropythonRelease = undefined;
  const code = [
    'import sys, os',
    "print('MPYVER:', sys.implementation.version)",
    "print('MPYRAW:', getattr(sys.implementation, '_mpy', 0))",
    "print('MAXSIZE:', sys.maxsize)",
    'u=os.uname()',
    "print('SYSNAME:', u.sysname)",
    "print('RELEASE:', u.release)"
  ].join('; ');
  const result = await deviceSession.run(['exec', code], { timeoutMs: 20_000 });
  const stdout = result.stdout;

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
        11: 'rv32imc',
        12: 'rv64imc'
  };

  function interpretMsmallIntBits(value: string): number | undefined {
        if (value === '2147483647') {
          return 31;
        }
        if (value === '9223372036854775807') {
          return 63;
        }
        if (value === '32767') {
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
        } else if (line.startsWith("MPYRAW:")) {
          const rawMpy = Number(line.replace("MPYRAW:", "").trim());
          const abi = decodeMpyAbi(rawMpy);
          micropythonBytecodeVersion = abi.bytecodeVersion;
          micropythonArchitecture = abi.architectureCode === undefined
            ? undefined
            : archMap[abi.architectureCode];
          mpyOutputChannel.appendLine(`📌 micropythonBytecodeVersion = ${micropythonBytecodeVersion ?? 'none'}`);
          mpyOutputChannel.appendLine(`📌 micropythonArchitecture = ${micropythonArchitecture || 'none'}`);
        } else if (line.startsWith("MAXSIZE:")) {
          const maxsizeValue = line.replace("MAXSIZE:", "").trim();
          micropythonMsmallIntBits = interpretMsmallIntBits(maxsizeValue);
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
  const relative = path.relative(srcPath, pyFilePath);
  const outPath = path.join(mpyPath, relative.replace(/\.py$/, '.mpy'));
  return compileFileToOutput(pyFilePath, outPath);
}

/** Compile one source file using the package's native binary whenever possible. */
async function compileFileToOutput(sourcePath: string, outPath: string): Promise<string> {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const args: string[] = [];
  if (micropythonArchitecture) {
    args.push(`-march=${micropythonArchitecture}`);
  } else {
    mpyOutputChannel.appendLine("⚠️ Warning: micropythonArchitecture not obtained. Omitting -march flag.");
  }
  if (micropythonMsmallIntBits) {
    args.push(`-msmall-int-bits=${micropythonMsmallIntBits}`);
  } else {
    mpyOutputChannel.appendLine("⚠️ Warning: micropythonMsmallIntBits not obtained. Omitting -msmall-int-bits flag.");
  }
  if (selectedCompilationMethod) {
    args.push(`-O${selectedCompilationMethod}`);
  }
  args.push(sourcePath, '-o', outPath);

  const bytecodeVersion = micropythonBytecodeVersion ?? getSupportedBytecodeVersion(micropythonVersion);
  if (bytecodeVersion === undefined) {
    mpyOutputChannel.appendLine("⚠️ Warning: Bytecode not supported for this version of MicroPython. Using the current mpy-cross bytecode.");
  }

  const result = await runMpyCross(args, bytecodeVersion);
  const hostLag = result.maxEventLoopDelayMs >= 250
    ? `, Extension Host lag ${result.maxEventLoopDelayMs.toFixed(1)} ms`
    : '';
  mpyOutputChannel.appendLine(
    `⚙️ mpy-cross [${result.target.mode}, ${result.durationMs.toFixed(1)} ms${hostLag}]: `
    + formatMpyCrossInvocation(result)
  );
  if (result.stdout.trim()) {
    console.log(`[mpy-cross stdout] ${result.stdout.trim()}`);
  }
  if (result.stderr.trim()) {
    console.error(`[mpy-cross stderr] ${result.stderr.trim()}`);
  }
  return outPath;
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
