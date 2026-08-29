import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandTarget, runProcess } from './processRunner';
import { ToolchainManager } from './toolchain';
import { resolveWorkspaceProjectFolder } from './workspaceProject';

const STDLIB_STUBS_VERSION = '1.28.0.post6';
const BOARD_STUB_PACKAGES = {
  ESP32: 'micropython-esp32-stubs==1.28.0.post4',
  RP2: 'micropython-rp2-stubs==1.28.0.post4',
  STM32: 'micropython-stm32-stubs==1.28.0.post5'
} as const;

export function registerDependenciesCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  toolchain: ToolchainManager
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mpytools.installDependencies', async () => {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Installing isolated MPyTools toolchain…',
        cancellable: false
      }, async () => {
        outputChannel.clear();
        outputChannel.show(true);
        outputChannel.appendLine('=== MPyTools managed toolchain ===');
        try {
          await toolchain.installManagedToolchain();
          vscode.window.showInformationMessage('MPyTools toolchain installed successfully.');
        } catch (error: any) {
          outputChannel.appendLine(`❌ ${error.message}`);
          if (/venv|ensurepip/i.test(error.message)) {
            outputChannel.appendLine('Install the Python venv package for your distribution and retry (Ubuntu/Debian: python3-venv).');
          }
          vscode.window.showErrorMessage(`MPyTools toolchain installation failed: ${error.message}`);
          throw error;
        }
      });
    }),
    vscode.commands.registerCommand('mpytools.installStubs', async () => {
      await installWorkspaceStubs(outputChannel, toolchain);
    })
  );
}

async function installWorkspaceStubs(
  outputChannel: vscode.OutputChannel,
  toolchain: ToolchainManager
): Promise<void> {
  const workspaceFolder = await resolveWorkspaceProjectFolder('Select the project where stubs should be installed');
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Open a workspace before installing MicroPython stubs.');
    return;
  }
  let managedPython = toolchain.managedPython();
  if (!managedPython) {
    const answer = await vscode.window.showInformationMessage(
      'The isolated MPyTools toolchain is required before installing stubs.',
      'Install Toolchain'
    );
    if (answer !== 'Install Toolchain') {
      return;
    }
    await toolchain.installManagedToolchain();
    managedPython = toolchain.managedPython();
  }
  if (!managedPython) {
    throw new Error('Managed Python was not created.');
  }

  const boardChoice = await vscode.window.showQuickPick([
    { label: 'Universal only', packageName: undefined as string | undefined },
    { label: 'ESP32', packageName: BOARD_STUB_PACKAGES.ESP32 },
    { label: 'RP2', packageName: BOARD_STUB_PACKAGES.RP2 },
    { label: 'STM32', packageName: BOARD_STUB_PACKAGES.STM32 }
  ], { placeHolder: 'Select optional board-specific stubs' });
  if (!boardChoice) {
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const typingsPath = path.join(workspaceRoot, '.mpytools', 'typings');
  fs.mkdirSync(typingsPath, { recursive: true });
  const packages = [`micropython-stdlib-stubs==${STDLIB_STUBS_VERSION}`];
  if (boardChoice.packageName) {
    packages.push(boardChoice.packageName);
  }
  const pythonTarget: CommandTarget = {
    executable: managedPython,
    prefixArgs: [],
    source: 'managed'
  };

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Installing MicroPython stubs into this workspace…',
    cancellable: false
  }, async () => {
    outputChannel.show(true);
    outputChannel.appendLine(`🔹 Installing stubs into ${typingsPath}`);
    const result = await runProcess(pythonTarget, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--upgrade',
      `--target=${typingsPath}`,
      ...packages
    ], { timeoutMs: 300_000 });
    if (result.stdout.trim()) {
      outputChannel.appendLine(result.stdout.trim());
    }
  });

  const pythonAnalysis = vscode.workspace.getConfiguration('python.analysis', workspaceFolder.uri);
  await pythonAnalysis.update(
    'stubPath',
    path.relative(workspaceRoot, typingsPath),
    vscode.ConfigurationTarget.WorkspaceFolder
  );
  vscode.window.showInformationMessage('MicroPython stubs installed without modifying pyproject.toml.');
}
