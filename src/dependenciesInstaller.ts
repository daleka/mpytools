// dependenciesInstaller.ts

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, exec } from 'child_process';
 
/**
 * Реєструє команду "mpytools.installDependencies".
 * Виконує встановлення залежностей, після чого встановлює локальні заглушки.
 *
 * **ВАЖЛИВО:** Щоб уникнути дублювання, видаліть (або закоментуйте)
 * встановлення micropython-stdlib-stubs із глобального скрипта (install-dependencies.ps1/‑sh).
 *
 * @param context       - контекст розширення
 * @param outputChannel - Output Channel для логування
 */
export function registerDependenciesCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
) {
  const disposableInstallCommand = vscode.commands.registerCommand('mpytools.installDependencies', async () => {
    const extensionRootFolder = context.extensionPath;
    let installationScriptPath = '';
    let installationScriptArguments: string[] = [];

    if (os.platform() === 'win32') {
      // Для Windows використовуємо PowerShell-скрипт
      installationScriptPath = path.join(extensionRootFolder, 'install-dependencies.ps1');
      installationScriptArguments = ['-ExecutionPolicy', 'Bypass', '-File', installationScriptPath];
    } else {
      // Для Linux/macOS — Bash-скрипт
      installationScriptPath = path.join(extensionRootFolder, 'install-dependencies.sh');
      installationScriptArguments = [installationScriptPath];
    }

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: '🔹 Installing dependencies...',
      cancellable: false
    }, () => {
      return new Promise<void>((resolve, reject) => {
        // Очищаємо канал виводу і відкриваємо його для виводу логу
        outputChannel.clear();
        outputChannel.show(false);
        outputChannel.appendLine("🔹 Installing dependencies...");
        outputChannel.appendLine(`   Script: ${installationScriptPath}`);

        // Запускаємо зовнішній процес (PowerShell або Bash)
        const installerProcess = spawn(
          os.platform() === 'win32' ? 'powershell' : 'bash',
          installationScriptArguments
        );

        // Зберігаємо, чи виявлено "externally-managed-environment"
        let externallyManagedErrorDetected = false;

        // Обробка стандартного виводу (stdout)
        installerProcess.stdout.on('data', (dataBuffer) => {
          const textOutput = dataBuffer.toString().trim();
          if (!textOutput) {
            return;
          }

          // Логіка відслідковування певних рядків — залишаємо без змін
          if (textOutput.includes("Python found!")) {
            outputChannel.appendLine("✅ Python found!");
          } else if (textOutput.includes("Upgrading pip")) {
            outputChannel.appendLine("🔹 Upgrading pip...");
          } else if (textOutput.includes("Installing mpremote")) {
            outputChannel.appendLine("🔹 Installing mpremote...");
          } else if (textOutput.includes("Installing mpy-cross")) {
            outputChannel.appendLine("🔹 Installing mpy-cross...");
          }
        });

        // Обробка виводу помилок (stderr)
        installerProcess.stderr.on('data', (errorBuffer) => {
          const errorText = errorBuffer.toString().trim();
          if (errorText) {
            outputChannel.appendLine("❌ Error: " + errorText);

            // Якщо виявлено "externally-managed-environment", позначаємо це
            if (errorText.includes("externally-managed-environment")) {
              externallyManagedErrorDetected = true;
            }
          }
        });

        // Коли процес завершується
        installerProcess.on('close', (exitCode) => {
          // Якщо виявлено помилку «externally-managed-environment»
          if (externallyManagedErrorDetected) {
            outputChannel.appendLine("❌ The system Python is externally managed (PEP 668).");
            // Показуємо інструкцію в Output Channel (і можемо додати у вікно)
            showExternallyManagedVenvInstructions(outputChannel);
            // Не виконуємо встановлення локальних заглушок, позаяк інсталяція провалилася
            vscode.window.showErrorMessage("Installation failed due to externally-managed-environment. Please check the Output panel.");
            reject(new Error("externally-managed-environment"));
            return;
          }

          // Якщо exitCode == 0, вважаємо, що інсталяція пройшла успішно
          if (exitCode === 0) {
            outputChannel.appendLine("✅ Dependencies installed.");
            // Переходимо до встановлення локальних заглушок
            installLocalMicropythonStubs(outputChannel)
              .then(() => {
                vscode.window.showInformationMessage("✅ Dependencies installed successfully!");
                outputChannel.appendLine("✅ Installation completed.");
                // Пропонуємо перезавантажити VSCode
                vscode.window.showInformationMessage(
                  "Installation completed. Do you want to reload VSCode for changes to take effect? / Встановлення завершено. Перезавантажити VSCode?",
                  "Yes", "No"
                ).then(answer => {
                  if (answer === "Yes") {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                  }
                });
                resolve();
              })
              .catch(stubsError => {
                vscode.window.showErrorMessage("❌ Failed to install stubs: " + stubsError.message);
                outputChannel.appendLine("❌ Failed to install stubs: " + stubsError.message);
                reject(stubsError);
              });
          } else {
            vscode.window.showErrorMessage(`❌ Installation failed with code ${exitCode}`);
            outputChannel.appendLine(`❌ Installation failed with code ${exitCode}`);
            reject(new Error(`Installation failed with code ${exitCode}`));
          }
        });
      });
    });
  });

  context.subscriptions.push(disposableInstallCommand);
}

/**
 * Якщо виявлено "externally-managed-environment", виводимо покрокову інструкцію у Output,
 * а також можемо продублювати (чи коротке посилання) у модальному діалозі VS Code.
 */
function showExternallyManagedVenvInstructions(outputChannel: vscode.OutputChannel): void {
  // Двомовна інструкція (англ./укр.)
  const instructionText = [
    "===== EXTERNALLY MANAGED ENVIRONMENT DETECTED =====",
    "It looks like your system Python is externally managed (PEP 668).",
    "You need to create or use a virtual environment in order to install packages correctly.",
    "",
    "Install python3-venv if it's missing (Встановіть python3-venv, якщо він відсутній):",
    "    sudo apt update",
    "    sudo apt install python3-venv",
    "",
    "Create a virtual environment (Створіть віртуальне середовище) in your project folder:",
    "    python3 -m venv .venv",
    "",
    "Activate the environment (Активуйте середовище):",
    "    source .venv/bin/activate",
    "",
    "Restart Visual Studio Code from the same terminal (Перезапустіть VS Code з цього ж термінала):",
    "    code .",
    "",
    "Then try 'Install Dependencies' again (Спробуйте ще раз 'Install Dependencies').",
    "",
    "Alternatively, you can consider using 'pipx' (Альтернатива — використовувати 'pipx'):",
    "    sudo apt install pipx",
    "    pipx install mpremote mpy-cross etc.",
    "This will keep system Python clean and isolate packages globally.",
    "====================================================\n"
  ].join("\n");

  // Виводимо всю інструкцію в наш Output Channel
  outputChannel.appendLine(instructionText);

  // За бажанням дублюємо коротке повідомлення у VS Code
  vscode.window.showInformationMessage(
    "Your Python environment is externally managed. See Output panel for steps to set up a virtual environment."
  );
}

/** 
 * Встановлює універсальні заглушки, оновлює конфігураційний файл (pyproject.toml),
 * а після цього запитує у користувача, чи встановлювати заглушки для конкретної плати.
 *
 * Перед встановленням залежностей пропонується обрати каталог з вашим проєктом,
 * що забезпечить коректну роботу залежностей.
 */
async function installLocalMicropythonStubs(outputChannel: vscode.OutputChannel): Promise<void> {
  outputChannel.appendLine("\n🔹 Installing universal stubs...");

  // Запитуємо користувача обрати папку з проєктом
  let workspaceRoot: string | undefined;
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    const chosenOption = await vscode.window.showQuickPick([
      { label: "Use current workspace folder", description: vscode.workspace.workspaceFolders[0].uri.fsPath },
      { label: "Select a different folder", description: "Choose your project folder" }
    ], { placeHolder: "Select your project folder for proper dependency operation" });

    if (chosenOption && chosenOption.label === "Use current workspace folder") {
      workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    } else {
      const folderDialogResult = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        openLabel: "Select your project folder"
      });
      if (folderDialogResult && folderDialogResult.length > 0) {
        workspaceRoot = folderDialogResult[0].fsPath;
      } else {
        throw new Error("No folder selected for dependency installation.");
      }
    }
  } else {
    const folderDialogResult = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      openLabel: "Select your project folder"
    });
    if (folderDialogResult && folderDialogResult.length > 0) {
      workspaceRoot = folderDialogResult[0].fsPath;
    } else {
      throw new Error("No folder selected for dependency installation.");
    }
  }

  const typingsPath = path.join(workspaceRoot, 'typings');

  try {
    if (fs.existsSync(typingsPath)) {
      outputChannel.appendLine("🔹 Removing existing stubs folder...");
      removeExistingFolderRecursively(typingsPath);
    }
    fs.mkdirSync(typingsPath, { recursive: true });
  } catch (folderError: any) {
    throw new Error("❌ Failed to recreate stubs folder: " + folderError.message);
  }

  outputChannel.appendLine("🔹 Installing micropython-stdlib-stubs...");
  await installPythonPackageToTarget('micropython-stdlib-stubs', typingsPath, outputChannel);
  outputChannel.appendLine("✅ Universal stubs installed.");

  outputChannel.appendLine("🔹 Updating configuration (pyproject.toml)...");
  const pyprojectPath = path.join(workspaceRoot, 'pyproject.toml');
  const pyprojectContent = `[tool.pyright]
include = ["src"]
ignore = ["**/typings"]
exclude = ["**/typings"]
typeCheckingMode = "basic"
stubPath = "typings"
typeshedPath = "typings"
pythonPlatform = "All"
reportMissingModuleSource = "none"
reportUnnecessaryTypeIgnoreComment = "error"
`;
  try {
    fs.writeFileSync(pyprojectPath, pyprojectContent, 'utf-8');
    outputChannel.appendLine("✅ Configuration updated.");
  } catch (pyprojectError: any) {
    throw new Error("❌ Failed to update configuration: " + pyprojectError.message);
  }

  // Після оновлення конфігурації запитуємо, чи встановлювати додаткові заглушки для плати
  const boardChoice = await vscode.window.showQuickPick(
    [
      { label: 'esp32', description: 'Install stubs for ESP32' },
      { label: 'rp2', description: 'Install stubs for RP2' },
      { label: 'stm32', description: 'Install stubs for STM32' },
      { label: 'skip', description: 'Skip board-specific stubs' }
    ],
    { placeHolder: 'Install board-specific stubs?', canPickMany: false }
  );
  if (boardChoice && boardChoice.label !== 'skip') {
    outputChannel.appendLine(`🔹 Installing board-specific stubs for ${boardChoice.label}...`);
    const stubsMap: Record<string, string> = {
      'esp32': 'micropython-esp32-stubs',
      'rp2': 'micropython-rp2-stubs',
      'stm32': 'micropython-stm32-stubs'
    };
    const stubPackage = stubsMap[boardChoice.label];
    await installPythonPackageToTarget(stubPackage, typingsPath, outputChannel);
  } else {
    outputChannel.appendLine("🔹 Skipping board-specific stubs.");
  }

  vscode.window.showInformationMessage("✅ Stubs installation completed.");
  outputChannel.appendLine("✅ Stubs installation completed.\n");
}

/**
 * Встановлює Python-пакет у вказану теку через pip з прапорцем --upgrade.
 */
function installPythonPackageToTarget(
  pythonPackageName: string,
  targetFolderPath: string,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const commandToInstall = `python -m pip install --upgrade --target="${targetFolderPath}" ${pythonPackageName}`;
    outputChannel.appendLine(`CMD: ${commandToInstall}`);
    exec(commandToInstall, (error, stdout, stderr) => {
      if (stdout) {
        // Виводимо першу строку, щоб не захаращувати лог
        outputChannel.appendLine("      " + stdout.trim().split('\n')[0]);
      }
      if (stderr) {
        outputChannel.appendLine("      " + stderr.trim().split('\n')[0]);
      }
      if (error) {
        return reject(error);
      }
      resolve();
    });
  });
}

/**
 * Рекурсивно видаляє теку (для очищення теки typings).
 */
function removeExistingFolderRecursively(folderPath: string): void {
  if (fs.existsSync(folderPath)) {
    fs.readdirSync(folderPath).forEach((fileName) => {
      const currentItemPath = path.join(folderPath, fileName);
      if (fs.lstatSync(currentItemPath).isDirectory()) {
        removeExistingFolderRecursively(currentItemPath);
      } else {
        fs.unlinkSync(currentItemPath);
      }
    });
    fs.rmdirSync(folderPath);
  }
}
