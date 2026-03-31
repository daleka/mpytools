// saveProject.ts

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Реєструє команду "mpytools.saveProject", а також додає кнопку в статус-бар
 * для виклику цієї команди.
 *
 * @param context        Контекст розширення, потрібен для реєстрації команд та збереження підписок.
 * @param outputChannel  Канал виводу (наприклад, mpyOutputChannel), куди логуватиметься процес.
 * @param execPromise    Функція для виконання shell-команд (з extension.ts).
 */ 
export function registerSaveProjectCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  execPromise: (command: string) => Promise<string>
): void {

  // 1. Створюємо кнопку (StatusBarItem) у статус-барі
  let saveProjectStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    -3
  );
  saveProjectStatusBarItem.text = '$(archive) Save Project';
  saveProjectStatusBarItem.tooltip = 'Архівувати проект (папка src) / Archive project (src folder)';
  saveProjectStatusBarItem.color = '#B8860B';
  saveProjectStatusBarItem.command = 'mpytools.saveProject'; // Імʼя команди
  saveProjectStatusBarItem.show();

  // Додаємо у підписки, щоб VSCode при зупинці розширення прибирав її
  context.subscriptions.push(saveProjectStatusBarItem);

  // 2. Реєструємо саму команду "mpytools.saveProject"
  let disposableSaveProject = vscode.commands.registerCommand(
    'mpytools.saveProject',
    async (): Promise<void> => {
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

      // Знаходимо нову версію
      const existingArchives = fs
        .readdirSync(saveFolderPath)
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

      // Формуємо команду архівації залежно від платформи
      let archiveCommand = '';
      if (os.platform() === 'win32') {
        archiveCommand = `powershell -Command "Compress-Archive -Path '${srcFolderPath}' -DestinationPath '${archiveFilePath}'"`;
      } else {
        archiveCommand = `cd "${workspaceRoot}" && zip -r "${archiveFilePath}" "src"`;
      }

      outputChannel.appendLine(`🔹 Save Project -> creating archive: ${archiveFileName}`);

      try {
        // Використовуємо надану з extension.ts функцію execPromise
        await execPromise(archiveCommand);
        vscode.window.showInformationMessage(`Проект збережено (Project saved) як: ${archiveFileName}`);
        outputChannel.appendLine(`✅ Project archived as: ${archiveFileName}\n`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Помилка при архівації (Archive error): ${err.message}`);
        outputChannel.appendLine(`❌ Archive error: ${err.message}`);
      }
    }
  );

  context.subscriptions.push(disposableSaveProject);
}

/**
 * Допоміжна функція визначення наступної версії.
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
