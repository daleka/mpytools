import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
 
import { mpyOutputChannel } from './extension';
import { micropythonSysName } from './extension';
import { getSelectedPort as getSharedSelectedPort } from './sharedState';

/** Нормалізація пристроєвого шляху – забезпечуємо, що шлях починається з "/" */
function normalizeDevicePath(p: string): string {
  let normalized = p;
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  return normalized.replace(/\\/g, '/');
}

/**
 * Формує віддалений шлях для mpremote (без початкового слешу після двокрапки).
 * Якщо пристрій є Pyboard (micropythonSysName містить "pyboard") та шлях починається з "/flash/",
 * то "/flash/" прибирається.
 */
function getRemoteFilePath(p: string): string {
  const normalized = normalizeDevicePath(p);
  if (micropythonSysName && micropythonSysName.toLowerCase().includes("pyboard") && normalized.startsWith('/flash/')) {
    return ':' + normalized.substring(7);
  }
  return ':' + normalized.substring(1);
}

/** Функція для отримання вибраного порту */
function getSelectedPort(): string {
  return getSharedSelectedPort() || 'auto';
}

/** Глобальна мапа для збереження відповідності тимчасового файлу та реального device-шляху */
const deviceFileMap: Map<string, string> = new Map<string, string>();

export function registerFileManager(context: vscode.ExtensionContext): void {
  const provider: FileManagerProvider = new FileManagerProvider();

  // Створення TreeView (тільки для пристрою)
  const treeView: vscode.TreeView<FileItem> = vscode.window.createTreeView('mpytoolsFileExplorer', {
    treeDataProvider: provider
  });
  context.subscriptions.push(treeView);

  // Глобальний refresh дерева
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.refresh', () => {
      provider.refresh();
    })
  );

  // "Refresh device" – оновлення дерева пристрою
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.refreshDevice', (item: FileItem) => {
      item.isLoaded = false;
      item.cachedChildren = undefined;
      provider.refresh(item);
    })
  );

  // Відкрити файл з пристрою
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytools.openDeviceFile', async (item: FileItem) => {
      if (!item.fullPath) { return; }
      try {
        mpyOutputChannel.appendLine(`📥 Opening device file: ${item.fullPath}`);
        await openDeviceFile(item);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open device file: ${err.message}`);
      }
    })
  );

  // Завантаження файлів з пристрою при збереженні (автоматичне завантаження назад на пристрій)
  vscode.workspace.onDidSaveTextDocument(async (document: vscode.TextDocument) => {
    const localPath = path.normalize(document.uri.fsPath).toLowerCase();
    if (deviceFileMap.has(localPath)) {
      const devicePath = deviceFileMap.get(localPath)!;
      try {
        await uploadDeviceFile(localPath, devicePath);
        mpyOutputChannel.appendLine(`✅ Uploaded file to device: ${devicePath}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to upload ${localPath} to device: ${err.message}`);
      }
    }
  });

  // Видалення мапування при закритті документа
  vscode.workspace.onDidCloseTextDocument((document: vscode.TextDocument) => {
    const localPath = path.normalize(document.uri.fsPath).toLowerCase();
    if (deviceFileMap.has(localPath)) {
      deviceFileMap.delete(localPath);
      mpyOutputChannel.appendLine(`🔗 Mapping removed for closed file: ${localPath}`);
    }
  });

  // ===== Команди для роботи з файлами/папками пристрою =====

  // Команда "Створити файл"
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.createDeviceFile', async (item: FileItem) => {
      const fileName = await vscode.window.showInputBox({ prompt: 'Enter new file name' });
      if (!fileName) { return; }
      const basePath = item.fullPath ? normalizeDevicePath(item.fullPath) : '/';
      const newFilePath = path.join(basePath, fileName).replace(/\\/g, '/');
      const port = getSelectedPort();
      const command = `mpremote connect ${port} fs touch ${getRemoteFilePath(newFilePath)}`;
      try {
        await execPromise(command);
        mpyOutputChannel.appendLine(`✅ Created file: ${newFilePath}`);
        provider.refresh(item);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create file: ${error.message}`);
      }
    })
  );

  // Команда "Створити папку"
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.createDeviceFolder', async (item: FileItem) => {
      const folderName = await vscode.window.showInputBox({ prompt: 'Enter new folder name' });
      if (!folderName) { return; }
      const basePath = item.fullPath ? normalizeDevicePath(item.fullPath) : '/';
      const newFolderPath = path.join(basePath, folderName).replace(/\\/g, '/');
      const port = getSelectedPort();
      const command = `mpremote connect ${port} fs mkdir ${getRemoteFilePath(newFolderPath)}`;
      try {
        await execPromise(command);
        mpyOutputChannel.appendLine(`✅ Created folder: ${newFolderPath}`);
        provider.refresh(item);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create folder: ${error.message}`);
      }
    })
  );

  // Команда "Перейменувати файл"
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.renameDeviceFile', async (item: FileItem) => {
      const currentName = path.basename(item.fullPath || '');
      const newName = await vscode.window.showInputBox({ prompt: 'Enter new file name', value: currentName });
      if (!newName) { return; }
      const parentPath = item.fullPath ? path.dirname(normalizeDevicePath(item.fullPath)) : '/';
      const newPath = path.join(parentPath, newName).replace(/\\/g, '/');
      const port = getSelectedPort();
      const copyCommand = `mpremote connect ${port} fs cp ${getRemoteFilePath(item.fullPath!)} ${getRemoteFilePath(newPath)}`;
      const removeCommand = `mpremote connect ${port} fs rm ${getRemoteFilePath(item.fullPath!)}`;
      try {
        await execPromise(copyCommand);
        mpyOutputChannel.appendLine(`✅ Copied file to: ${newPath}`);
        await execPromise(removeCommand);
        mpyOutputChannel.appendLine(`✅ Removed old file: ${item.fullPath}`);
        provider.refresh();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to rename device file: ${error.message}`);
      }
    })
  );

  // Команда "Видалити файл"
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.deleteDeviceFile', async (item: FileItem) => {
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete file "${item.fullPath}"?`,
        { modal: true },
        'Yes'
      );
      if (confirm !== 'Yes') { return; }
      const port = getSelectedPort();
      const command = `mpremote connect ${port} fs rm ${getRemoteFilePath(item.fullPath!)}`;
      try {
        await execPromise(command);
        mpyOutputChannel.appendLine(`✅ Deleted device file: ${item.fullPath}`);
        provider.refresh();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to delete device file: ${error.message}`);
      }
    })
  );

  // Команда "Відправити файл у локальний проєкт"
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.sendDeviceFileToLocal', async (item: FileItem) => {
      if (!item.fullPath) { return; }
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("No workspace folder is open.");
        return;
      }
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const relativeDevicePath = item.fullPath.replace(/^\//, '');
      // Файли пристрою зберігаються в окремій папці "device" всередині робочої області
      const destPath = path.join(workspaceRoot, 'device', relativeDevicePath);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      if (fs.existsSync(destPath)) {
        const confirm = await vscode.window.showWarningMessage(
          `File ${destPath} already exists. Replace?`,
          { modal: true },
          'Yes'
        );
        if (confirm !== 'Yes') {
          return;
        }
      }
      const port = getSelectedPort();
      const command = `mpremote connect ${port} fs cp ${getRemoteFilePath(item.fullPath)} ${destPath}`;
      try {
        await execPromise(command);
        mpyOutputChannel.appendLine(`✅ Sent device file to local project: ${destPath}`);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to send device file to local project: ${error.message}`);
      }
    })
  );

  // Команда "Видалити папку" (рекурсивне видалення)
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.deleteDeviceFolder', async (item: FileItem) => {
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete folder "${item.fullPath}" and all its contents?`,
        { modal: true },
        'Yes'
      );
      if (confirm !== 'Yes') { return; }
      try {
        await deleteDeviceFolderRecursively(item.fullPath!);
        mpyOutputChannel.appendLine(`✅ Deleted device folder: ${item.fullPath}`);
        provider.refresh();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to delete device folder: ${error.message}`);
      }
    })
  );

  // Команда "Заміряти пам'ять"
  vscode.commands.registerCommand('mpytoolsFileExplorer.measureDeviceSpace', async (item: FileItem) => {
    const port = getSelectedPort();
    try {
      const output = await execPromise(`mpremote connect ${port} df`);
      mpyOutputChannel.appendLine(`Raw df output: ${output}`);
      const lines = output.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      let dfLine: string | undefined = lines.find(line => {
        const parts = line.split(/\s+/);
        return parts.length >= 3 && !isNaN(Number(parts[0]));
      });
      if (!dfLine && lines.length >= 2) {
        dfLine = lines[1];
      }
      let description = '';
      if (dfLine) {
        const parts = dfLine.split(/\s+/);
        if (parts.length >= 3) {
          const size = Number(parts[0]);
          const used = Number(parts[1]);
          const avail = Number(parts[2]);
          const sizeKB = size < 1024 ? size : Math.round(size / 1024);
          const usedKB = used < 1024 ? used : Math.round(used / 1024);
          const availKB = avail < 1024 ? avail : Math.round(avail / 1024);
          description = `Total: ${sizeKB} KB, Used: ${usedKB} KB, Free: ${availKB} KB`;
        } else {
          description = output;
        }
      } else {
        description = output;
      }
      item.description = description;
      mpyOutputChannel.appendLine(`✅ Device space: ${description}`);
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to measure device space: ${error.message}`);
    }
  });

  // Команда "Очистити пристрій"
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytoolsFileExplorer.clearDevice', async (item: FileItem) => {
      const confirm = await vscode.window.showWarningMessage(
        `This will clear ALL files and folders on the device. Are you sure?`,
        { modal: true },
        'Yes'
      );
      if (confirm !== 'Yes') { return; }
      try {
        await clearDevice();
        mpyOutputChannel.appendLine(`✅ Device cleared.`);
        vscode.commands.executeCommand('mpytoolsFileExplorer.refreshDevice', item);
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to clear device: ${error.message}`);
      }
    })
  );
}

/** Функція відкриття файлу з пристрою */
async function openDeviceFile(fileItem: FileItem): Promise<void> {
  const devicePath: string = fileItem.fullPath!;
  const port: string = getSelectedPort();

  const temporaryDirectory: string = path.join(os.tmpdir(), 'mpytools_temp');
  if (!fs.existsSync(temporaryDirectory)) {
    fs.mkdirSync(temporaryDirectory, { recursive: true });
  }

  const baseName: string = path.basename(fileItem.label, path.extname(fileItem.label));
  const fileExtension: string = path.extname(fileItem.label);
  const temporaryFileName: string = `${baseName}-${Date.now()}${fileExtension}`;
  const temporaryFilePath: string = path.join(temporaryDirectory, temporaryFileName);

  mpyOutputChannel.appendLine(`⬇️ Downloading file from device: ${devicePath}`);
  await downloadDeviceFile(devicePath, temporaryFilePath);

  const document: vscode.TextDocument = await vscode.workspace.openTextDocument(temporaryFilePath);
  await vscode.window.showTextDocument(document, { preview: false });

  const canonicalTemporaryPath = path.normalize(temporaryFilePath).toLowerCase();
  deviceFileMap.set(canonicalTemporaryPath, devicePath);
  mpyOutputChannel.appendLine(`🔗 Mapping set: ${canonicalTemporaryPath} -> ${devicePath}`);
}

async function downloadDeviceFile(devicePath: string, localPath: string): Promise<void> {
  const port: string = getSelectedPort();
  const command: string = `mpremote connect ${port} fs cp :${devicePath} ${localPath}`;
  try {
    await execPromise(command);
    mpyOutputChannel.appendLine(`⬇️ Download complete: ${localPath}`);
  } catch (error: any) {
    throw error;
  }
}

async function uploadDeviceFile(localPath: string, devicePath: string): Promise<void> {
  const port: string = getSelectedPort();
  const command: string = `mpremote connect ${port} fs cp -f ${localPath} :${devicePath}`;
  try {
    await execPromise(command);
    mpyOutputChannel.appendLine(`⬆️ Upload complete: ${localPath} to ${devicePath}`);
  } catch (error: any) {
    throw error;
  }
}

/** Рекурсивне видалення папки на пристрої з детальним логуванням */
async function deleteDeviceFolderRecursively(folderPath: string): Promise<void> {
  const port = getSelectedPort();
  const listCommand = `mpremote connect ${port} fs ls ${getRemoteFilePath(folderPath)}`;
  let output: string;
  try {
    output = await execPromise(listCommand);
  } catch (err: any) {
    throw new Error(`Failed to list folder contents: ${err.message}`);
  }
  const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('ls :'));
  for (const line of lines) {
    const parts = line.split(/\s+/, 2);
    if (parts.length < 2) {
      continue;
    }
    let entryName = parts[1];
    const isDir = entryName.endsWith('/');
    if (isDir) {
      entryName = entryName.replace(/\/+$/, '');
    }
    const childPath = folderPath.endsWith('/') ? folderPath + entryName : folderPath + '/' + entryName;
    if (isDir) {
      await deleteDeviceFolderRecursively(childPath);
    } else {
      mpyOutputChannel.appendLine(`Deleting file: ${childPath}`);
      await execPromise(`mpremote connect ${port} fs rm ${getRemoteFilePath(childPath)}`);
      mpyOutputChannel.appendLine(`Deleted file: ${childPath}`);
    }
  }
  mpyOutputChannel.appendLine(`Deleting folder: ${folderPath}`);
  await execPromise(`mpremote connect ${port} fs rmdir ${getRemoteFilePath(folderPath)}`);
  mpyOutputChannel.appendLine(`Deleted folder: ${folderPath}`);
}

/** Функція для очищення пристрою (видалення ВСЬОГО в корені) */
async function clearDevice(): Promise<void> {
  // Закриваємо всі активні MPY термінали
  const terminals: vscode.Terminal[] = vscode.window.terminals.filter(terminal => terminal.name.startsWith('MPY'));
  terminals.forEach(terminal => terminal.dispose());
  await new Promise(resolve => setTimeout(resolve, 300));

  const port = getSelectedPort();
  // Якщо пристрій є Pyboard, використовуємо '/flash/' (з фінальним слешем) як корінь
  const isPyboard = micropythonSysName && micropythonSysName.toLowerCase().includes("pyboard");
  const rootPath = isPyboard ? '/flash/' : '/';
  const listCommand = `mpremote connect ${port} fs ls ${getRemoteFilePath(rootPath) || ':'}`;
  let output: string;
  try {
    output = await execPromise(listCommand);
  } catch (error: any) {
    throw new Error(`Failed to list device root: ${error.message}`);
  }
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('ls :'));
  for (const line of lines) {
    const parts = line.split(/\s+/, 2);
    if (parts.length < 2) {
      continue;
    }
    // Видаляємо зайві слеші
    let entryName = parts[1].replace(/\/+$/, '');
    const isDir = parts[1].endsWith('/');
    
    // Якщо файл називається "System" (без врахування регістру), пропускаємо його
    if (!isDir && entryName.toLowerCase() === 'system') {
      mpyOutputChannel.appendLine(`Skipping system file: ${rootPath}${entryName}`);
      continue;
    }
    
    // Формуємо повний шлях на основі кореня (для Pyboard це буде '/flash/...')
    const fullEntryPath = rootPath.endsWith('/') ? `${rootPath}${entryName}` : `${rootPath}/${entryName}`;
    if (isDir) {
      await deleteDeviceFolderRecursively(fullEntryPath);
    } else {
      mpyOutputChannel.appendLine(`Deleting file: ${fullEntryPath}`);
      await execPromise(`mpremote connect ${port} fs rm ${getRemoteFilePath(fullEntryPath)}`);
      mpyOutputChannel.appendLine(`Deleted file: ${fullEntryPath}`);
    }
  }
}



class FileManagerProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | void> =
    new vscode.EventEmitter<FileItem | undefined | void>();
  public readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | void> =
    this._onDidChangeTreeData.event;

  public refresh(element?: FileItem): void {
    this._onDidChangeTreeData.fire(element);
  }

  public getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: FileItem): Promise<FileItem[]> {
    if (!element) {
      // Якщо порт не вибраний або дорівнює 'auto', повертаємо елемент для вибору порту
      if (getSelectedPort() === 'auto' || !getSharedSelectedPort()) {
        const selectPortItem = new FileItem("🔌 Select Port", vscode.TreeItemCollapsibleState.None, 'select-port');
        selectPortItem.command = {
          command: 'mpytools.selectPort',
          title: 'Select Port'
        };
        return [selectPortItem];
      }
      // Інакше створюємо кореневий елемент пристрою
      const label = micropythonSysName ? `🔲 ${micropythonSysName}` : 'device (click to expand)';
      const deviceIdentifier = 'device-root-' + getSelectedPort() + '-' + Date.now();
      const deviceItem: FileItem = new FileItem(label, vscode.TreeItemCollapsibleState.Collapsed, 'device-root', '/');
      deviceItem.id = deviceIdentifier;
      deviceItem.isLoaded = false;
      deviceItem.cachedChildren = undefined;
      return [deviceItem];
    }
    if (element.contextValue === 'device-root' || element.contextValue === 'device-folder') {
      if (!element.isLoaded) {
        const children: FileItem[] = await this.readDeviceDirectory(element.fullPath || '/', 'device-file');
        if (element.contextValue === 'device-root') {
          // Додаємо кнопку "♻️ Refresh" для кореневого елемента
          const refreshItem: FileItem = new FileItem(
            '♻️ Refresh',
            vscode.TreeItemCollapsibleState.None,
            'refresh-device',
            element.fullPath
          );
          refreshItem.command = {
            command: 'mpytoolsFileExplorer.refreshDevice',
            title: 'Refresh device',
            arguments: [element]
          };
          children.unshift(refreshItem);
        }
        element.isLoaded = true;
        element.cachedChildren = children;
        return children;
      } else {
        return element.cachedChildren || [];
      }
    }
    return [];
  }

  private async readDeviceDirectory(deviceDirectoryPath: string, baseContextValue: string): Promise<FileItem[]> {
    const port: string = getSelectedPort();
    if (!port) {
      return [];
    }
    const terminals: vscode.Terminal[] = vscode.window.terminals.filter(terminal => terminal.name.startsWith('MPY'));
    terminals.forEach(terminal => terminal.dispose());
    await new Promise(resolve => setTimeout(resolve, 300));
    mpyOutputChannel.show(true);
    const commandForListing: string = `mpremote connect ${port} fs ls ${deviceDirectoryPath}`;
    let rawOutputLines: string[] = [];
    try {
      const commandOutput: string = await execPromise(commandForListing);
      rawOutputLines = commandOutput.split('\n').map(line => line.trim()).filter(line => line !== '');
    } catch (error: any) {
      mpyOutputChannel.show(true);
      mpyOutputChannel.appendLine(`⚠️ Error updating folder ${deviceDirectoryPath}: ${error.message}`);
      return [];
    }
    const items: FileItem[] = [];
    for (const line of rawOutputLines) {
      if (line.startsWith('ls :')) {
        continue;
      }
      const parts: string[] = line.split(/\s+/, 2);
      if (parts.length < 2) {
        continue;
      }
      let rawName: string = parts[1];
      let isDirectory: boolean = false;
      if (rawName.endsWith('/')) {
        isDirectory = true;
        rawName = rawName.replace(/\/+$/, '');
      }
      let displayName = rawName;
      if (isDirectory) {
        displayName = '📁 ' + rawName;
      }
      const collapsibleStateForChild = isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      const contextValueForChild = isDirectory ? 'device-folder' : 'device-file';
      const childDevicePath = deviceDirectoryPath.endsWith('/') ? deviceDirectoryPath + rawName : deviceDirectoryPath + '/' + rawName;
      const fakeLocalPath = path.join('/MPY_DEVICE', childDevicePath);
      const fileItemForChild: FileItem = new FileItem(displayName, collapsibleStateForChild, contextValueForChild, childDevicePath);
      fileItemForChild.resourceUri = vscode.Uri.file(fakeLocalPath);
      fileItemForChild.id = `device-item-${childDevicePath}-${Date.now()}`;
      if (contextValueForChild === 'device-file') {
        fileItemForChild.command = {
          command: 'mpytools.openDeviceFile',
          title: 'Open File',
          arguments: [fileItemForChild]
        };
      }
      items.push(fileItemForChild);
    }
    mpyOutputChannel.show(true);
    mpyOutputChannel.appendLine(`✅ Updated device folder: ${deviceDirectoryPath}`);
    return items;
  }
}

class FileItem extends vscode.TreeItem {
  public isLoaded: boolean = false;
  public cachedChildren: FileItem[] | undefined;
  public fullPath?: string;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    fullPath?: string
  ) {
    super(label, collapsibleState);
    this.fullPath = fullPath;
  }
}

function execPromise(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, (error: Error | null, standardOutput: string, standardError: string) => {
      if (error) {
        mpyOutputChannel.appendLine(`❌ ${error.message}`);
        return reject(error);
      }
      if (standardError && standardError.trim()) {
        mpyOutputChannel.appendLine(`❌ ${standardError.trim()}`);
        return reject(new Error(standardError.trim()));
      }
      resolve(standardOutput);
    });
  });
}
