import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Регіструє команду "mpytools.installDependencies".
 * Логіка виклику скриптів (PowerShell / Bash) розміщена тут.
 *
 * @param context  - контекст розширення
 * @param outputChannel - єдиний Output Channel для логування
 */
export function registerDependenciesCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel
) {
  const disposable = vscode.commands.registerCommand('mpytools.installDependencies', async () => {
    const extensionRoot = context.extensionPath;
    let scriptPath = '';
    let args: string[] = [];

    // Визначимо, який скрипт запускати (Windows / Linux/Mac)
    if (os.platform() === 'win32') {
      scriptPath = path.join(extensionRoot, 'install-dependencies.ps1');
      // Для Windows запускаємо через PowerShell з політикою Bypass
      args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    } else {
      scriptPath = path.join(extensionRoot, 'install-dependencies.sh');
      // Для Linux/Mac запускаємо через bash
      args = [scriptPath];
    }

    // Показуємо короткий прогрес у Notification, а детальний лог у Output Channel
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Installing dependencies...',
      cancellable: false
    }, () => {
      return new Promise<void>((resolve, reject) => {

        // Очищуємо канал
        outputChannel.clear();
        // Зробимо канал активним (щоб користувач бачив лог)
        outputChannel.show(false);

        outputChannel.appendLine("🔹 Starting dependency installation...");
        outputChannel.appendLine(`   Script: ${scriptPath}`);

        const command = (os.platform() === 'win32') ? 'powershell' : 'bash';
        const installer = spawn(command, args);

        // З кожного рядка stdout робимо обробку:
        installer.stdout.on('data', (data) => {
          const text = data.toString().trim();
          if (!text) {
            return;
          }
          // Виводимо в лог, а також можна підміняти емодзі, якщо треба
          const lines = text.split('\n');
          for (const line of lines) {
            let niceLine = line;

            // Підміна деяких рядків на емодзі
            if (line.includes("Checking for Python...")) {
              niceLine = "🔹 Checking for Python...";
            } else if (line.includes("SUCCESS: Python found!")) {
              niceLine = "✅ Python found!";
            } else if (line.includes("Upgrading pip...")) {
              niceLine = "🔹 Upgrading pip...";
            } else if (line.includes("Installing mpremote...")) {
              niceLine = "🔹 Installing mpremote...";
            } else if (line.includes("Installing mpy-cross...")) {
              niceLine = "🔹 Installing mpy-cross...";
            } else if (line.includes("Installing micropython-stdlib-stubs...")) {
              niceLine = "🔹 Installing micropython-stdlib-stubs...";
            } else if (line.includes("SUCCESS: All dependencies installed!")) {
              niceLine = "✅ All dependencies installed!";
            }

            outputChannel.appendLine(niceLine);
          }
        });

        installer.stderr.on('data', (data) => {
          const errMsg = data.toString().trim();
          if (errMsg) {
            outputChannel.appendLine("❌ ERROR: " + errMsg);
          }
        });

        installer.on('close', (code) => {
          if (code === 0) {
            vscode.window.showInformationMessage("✅ All dependencies installed!");
            outputChannel.appendLine("✅ Installation completed.");
            resolve();
          } else {
            vscode.window.showErrorMessage(`Dependency installation failed with code ${code}`);
            outputChannel.appendLine(`❌ Installation failed with code ${code}`);
            reject(new Error(`Installation failed with code ${code}`));
          }
        });
      });
    });
  });

  context.subscriptions.push(disposable);
}
