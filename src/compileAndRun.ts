//compileAndRun.ts 

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
 

/**
 * Функція реєструє кнопку та команду "mpytools.compileAndRun".
 * Уся логіка (запит оптимізації, компіляція, копіювання, запуск main) перенесена сюди з extension.ts.
 *
 * @param context               - контекст розширення
 * @param outputChannel         - канал виводу
 * @param execPromise           - функція для виконання shell-команд
 * @param getLastUsedPort       - функція-гетер для lastUsedPort
 * @param getSelectedMethod     - функція-гетер для selectedCompilationMethod
 * @param setSelectedMethod     - функція-сетер для export function registerCompileAndRunCommand(
 * @param needsRecompile        - функція перевірки потреби перекомпіляції
 * @param compilePyFile         - функція компіляції одного .py у .mpy
 * @param findPyFiles           - функція пошуку .py в папці src
 * @param openTerminalAndRunMain - функція запуску main (mpremote connect ... + repl)
 * @param formatPort            - функція форматування порту
 * @param getMicropythonVersion - функція-гетер для micropythonVersion
 * @param getMicropythonBytecodeVersion - функція-гетер для micropythonBytecodeVersion
 * @param getMicropythonArchitecture - функція-гетер для micropythonArchitecture
 * @param getMicropythonMsmallIntBits - функція-гетер для micropythonMsmallIntBits
 *
 * @returns {vscode.StatusBarItem} Статус-бар елемент.
 */

export function registerCompileAndRunCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  execPromise: (cmd: string) => Promise<string>,
  getLastUsedPort: () => string,
  getSelectedMethod: () => string | undefined,
  setSelectedMethod: (val: string | undefined) => void,
  needsRecompile: (pyFilePath: string, srcPath: string, mpyPath: string) => boolean,
  compilePyFile: (pyFilePath: string, srcPath: string, mpyPath: string) => Promise<string>,
  findPyFiles: (rootDir: string, ignoreList?: string[]) => string[],
  openTerminalAndRunMain: (port: string, debugTerminal: vscode.Terminal) => Promise<void>,
  formatPort: (port: string) => string,
  getMicropythonVersion: () => string | undefined,
  getMicropythonBytecodeVersion: () => number | undefined,
  getMicropythonArchitecture: () => string | undefined,
  getMicropythonMsmallIntBits: () => number | undefined
): vscode.StatusBarItem {
  // 1) Створюємо кнопку для "Compile & Run"
  let compileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
  compileStatusBarItem.text = '$(rocket)Compile&Run';
  compileStatusBarItem.tooltip = 'Click to compile and run the project';
  compileStatusBarItem.color = '#00BFFF';
  compileStatusBarItem.command = 'mpytools.compileAndRun';
  compileStatusBarItem.hide();
  context.subscriptions.push(compileStatusBarItem);

  // Допоміжна функція для логування з автопрокруткою
  function logAndScroll(message: string): void {
    outputChannel.appendLine(message);
    Promise.resolve(vscode.commands.executeCommand('workbench.action.output.scrollDown')).catch(() => {});
  }

  // 2) Реєструємо команду "mpytools.compileAndRun"
  let disposableCompileAndRun = vscode.commands.registerCommand('mpytools.compileAndRun', async () => {
    // 2.1 Перевірка незбережених файлів
    const unsavedDocs = vscode.workspace.textDocuments.filter(doc => doc.isDirty);
    if (unsavedDocs.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        'You have unsaved files. Do you want to save them before compiling? / У вас є незбережені файли. Бажаєте зберегти їх перед компіляцією?',
        'Yes / Так',
        'No / Ні'
      );
      if (choice === 'Yes / Так') {
        await vscode.workspace.saveAll();
      }
    }

    // 2.2 Перевірка відкритого Workspace
    let workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder opened.');
      return;
    }

    // 2.3 Запит методу оптимізації/компіляції
    let currentMethod = getSelectedMethod();
    if (!currentMethod) {
      const compilationOptions: vscode.QuickPickItem[] = [
        { label: 'mpy-cross optimization Level 0', description: 'No optimization' },
        { label: 'mpy-cross optimization Level 1', description: 'Basic optimization' },
        { label: 'mpy-cross optimization Level 2', description: 'Medium optimization' },
        { label: 'mpy-cross optimization Level 3', description: 'Max optimization' },
        { label: 'No Compilation', description: 'Upload source files directly without compiling' }
      ];
      const result = await vscode.window.showQuickPick(compilationOptions, {
        placeHolder: 'Choose mpy-cross optimization level or select "No Compilation"',
        canPickMany: false
      });
      if (!result) {
        vscode.window.showWarningMessage('Compilation canceled: no method selected.');
        return;
      }
      if (result.label === 'No Compilation') {
        setSelectedMethod('none');
        currentMethod = 'none';
      } else {
        const match = result.label.match(/Level (\d+)/);
        const chosen = match ? match[1] : '0';
        setSelectedMethod(chosen);
        currentMethod = chosen;
      }
    }

    // 2.4 Підготовчі змінні
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const srcPath = path.join(workspaceRoot, 'src');
    const mpyPath = path.join(workspaceRoot, 'mpy');

    // Закриваємо термінали MPY
    vscode.window.terminals.forEach((t) => {
      if (t.name.startsWith('MPY')) {
        t.dispose();
      }
    });
    await new Promise(resolve => setTimeout(resolve, 300));

    outputChannel.show(false);
    logAndScroll("🔹 Starting Compile & Run...");
    logAndScroll(`   - Selected method: ${currentMethod === 'none' ? 'No Compilation' : 'Optimization O' + currentMethod}`);

    // Нова зміна: змінюємо стан кнопки на активний – червоний із спінером
    compileStatusBarItem.text = '$(sync~spin)Compile&Run';
    compileStatusBarItem.color = 'red';

    // 2.5 Основний процес з індикацією Progress
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'MPyTools: Compile & Run',
      cancellable: false
    }, async (progress) => {
      let compiledCount = 0;
      let wrappedNonPyCount = 0;
      let copiedRawNonPyCount = 0;

      if (currentMethod !== 'none') {
        // --- Компіляційний режим ---
        progress.report({ message: 'Preparing compilation...' });
        logAndScroll("🔹 Preparing compilation...");
        if (!fs.existsSync(mpyPath)) {
          fs.mkdirSync(mpyPath);
          vscode.window.showInformationMessage(`Created directory: ${mpyPath}`);
          logAndScroll(`   ✅ Created directory: ${mpyPath}`);
        }

        // Знаходимо всі файли у директорії src (рекурсивно)
        let allFiles: string[] = [];
        (function recurse(dir: string) {
          if (!fs.existsSync(dir)) { return; }
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (let entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              recurse(fullPath);
            } else {
              allFiles.push(fullPath);
            }
          }
        })(srcPath);
        logAndScroll(`   🔹 Found ${allFiles.length} total files in "src".`);

        // Обробляємо кожен файл: компіляція для .py, обгортка+компіляція для інших
        for (let i = 0; i < allFiles.length; i++) {
          const filePath = allFiles[i];
          const shortName = path.relative(workspaceRoot, filePath);
          const extName = path.extname(filePath).toLowerCase();

          if (extName === '.py') {
            if (needsRecompile(filePath, srcPath, mpyPath)) {
              progress.report({ message: `Compiling: ${shortName}` });
              logAndScroll(`   🔹 Compiling: ${shortName}`);
              try {
                await compilePyFile(filePath, srcPath, mpyPath);
                compiledCount++;
                logAndScroll(`      ✅ OK: ${shortName}`);
              } catch (err: any) {
                vscode.window.showWarningMessage(`Compilation error: ${shortName}\n${err}`);
                logAndScroll(`      ❌ Compilation error: ${shortName} -> ${err.message}`);
              }
              logAndScroll("");
            } else {
              logAndScroll(`   🔹 Skipped (unchanged .py): ${shortName}`);
              logAndScroll("");
            }
          } else {
            const relativeFromSrc = path.relative(srcPath, filePath);
            const outAssetPath = getAssetOutputPath(filePath, srcPath, mpyPath);
            const outRawPath = path.join(mpyPath, relativeFromSrc);
            const keepRaw = shouldKeepAssetRaw(filePath);

            if (keepRaw) {
              if (fs.existsSync(outAssetPath)) {
                fs.unlinkSync(outAssetPath);
                logAndScroll(`      🧹 Removed stale wrapped asset: ${path.relative(workspaceRoot, outAssetPath)}`);
              }
              if (!fs.existsSync(outRawPath) || !areFilesIdentical(filePath, outRawPath)) {
                progress.report({ message: `Copying raw asset: ${shortName}` });
                copyWithMkDir(filePath, outRawPath);
                copiedRawNonPyCount++;
                logAndScroll(`      ✅ Copied raw asset: ${shortName}`);
              } else {
                logAndScroll(`   🔹 Skipped (unchanged raw asset): ${shortName}`);
              }
            } else {
              if (fs.existsSync(outRawPath)) {
                fs.unlinkSync(outRawPath);
                logAndScroll(`      🧹 Removed stale raw asset: ${path.relative(workspaceRoot, outRawPath)}`);
              }
              const shouldWrap = needsAssetRecompile(filePath, outAssetPath);
              if (shouldWrap) {
                progress.report({ message: `Wrapping+compiling asset: ${shortName}` });
                logAndScroll(`   🔹 Wrapping+compiling asset: ${shortName}`);
                try {
                  await compileNonPyFileAsAsset(filePath, srcPath, mpyPath, execPromise);
                  wrappedNonPyCount++;
                  logAndScroll(`      ✅ OK: ${shortName} -> ${path.relative(workspaceRoot, outAssetPath)}`);
                } catch (err: any) {
                  vscode.window.showWarningMessage(`Asset wrapping/compilation error: ${shortName}\n${err}`);
                  logAndScroll(`      ❌ Asset wrapping/compilation error: ${shortName} -> ${err.message}`);
                }
              } else {
                logAndScroll(`   🔹 Skipped (unchanged wrapped asset): ${shortName}`);
              }
            }

            logAndScroll("");
          }
        }
        logAndScroll(`   ✅ Compiled ${compiledCount} .py files; Wrapped+compiled ${wrappedNonPyCount} non-py files; Copied raw ${copiedRawNonPyCount} web/static assets.`);
      } else {
        // --- Режим "No Compilation" ---
        progress.report({ message: 'Skipping compilation, uploading source files...' });
        logAndScroll("🔹 Skipping compilation. Uploading source files directly from 'src'...");
      }

      // 2.6 Копіюємо файли на пристрій
      const usedPort = getLastUsedPort();
      const finalPort = (usedPort === 'auto') ? 'auto' : formatPort(usedPort);
      let copyPath: string;
      if (currentMethod !== 'none') {
        copyPath = os.platform() === 'win32' ? `${mpyPath}\\.` : `${mpyPath}/.`;
      } else {
        copyPath = os.platform() === 'win32' ? `${srcPath}\\.` : `${srcPath}/.`;
      }
      const copyCmd = (finalPort === 'auto')
        ? `mpremote connect auto fs cp -r "${copyPath}" ":/"`
        : `mpremote connect ${finalPort} fs cp -r "${copyPath}" ":/"`;

      logAndScroll("🔹 Copying files to device...");
      try {
        await execPromise(copyCmd);
        vscode.window.showInformationMessage('Copy complete.');
        logAndScroll("   ✅ Copy complete.");
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error copying files: ${err}`);
        logAndScroll(`   ❌ Error copying files: ${err.message}`);
        compileStatusBarItem.text = '$(rocket)Compile&Run';
        compileStatusBarItem.color = '#00BFFF';
        return;
      }

      // 2.7 (Опційно) Оцінимо розмір скопійованої теки
      const folderSizeKB = getFolderSizeKB(currentMethod !== 'none' ? mpyPath : srcPath);
      logAndScroll(`🔹 Total size of uploaded folder: ${folderSizeKB.toFixed(2)} KB`);
      logAndScroll("🔹 Launching main...");

      // Невелика затримка для перегляду логів
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Повертаємо кнопку до нормального стану
      compileStatusBarItem.text = '$(rocket)Compile&Run';
      compileStatusBarItem.color = '#00BFFF';

      // 2.8 Запускаємо main
      let debugTerminal = vscode.window.createTerminal('MPY Debugging');
      debugTerminal.show();

      if (currentMethod !== 'none') {
        // Для режиму компіляції: підключаємося і відправляємо main.run()
        await openTerminalAndRunMain(finalPort, debugTerminal);
      } else {
        // Для режиму "No Compilation": просто підключаємося без відправки main.run()
        debugTerminal.sendText(`mpremote connect ${finalPort} exec "import main" + repl`);
      }

      compileStatusBarItem.text = '$(rocket)Compile&Run';
      compileStatusBarItem.color = '#00BFFF';
    });
  });

  context.subscriptions.push(disposableCompileAndRun);
  return compileStatusBarItem;
}

/**
 * Копіює файл із `srcFile` у `destFile`, створюючи проміжні директорії за потреби.
 */
function copyWithMkDir(srcFile: string, destFile: string) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(srcFile, destFile);
}

function getAssetOutputPath(filePath: string, srcPath: string, mpyPath: string): string {
  const relativeFromSrc = path.relative(srcPath, filePath);
  const ext = path.extname(relativeFromSrc);
  const withoutExt = ext ? relativeFromSrc.slice(0, -ext.length) : relativeFromSrc;
  const assetRelative = `${withoutExt}.mpy`;
  return path.join(mpyPath, assetRelative);
}

function shouldKeepAssetRaw(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const rawAssetExtensions = new Set([
    '.html', '.htm', '.css', '.js', '.json', '.txt',
    '.svg', '.png', '.jpg', '.jpeg', '.ico', '.webp',
    '.gif', '.xml', '.csv', '.map', '.woff', '.woff2', '.ttf'
  ]);
  return rawAssetExtensions.has(ext);
}

function needsAssetRecompile(sourceFilePath: string, outAssetPath: string): boolean {
  if (!fs.existsSync(outAssetPath)) {
    return true;
  }
  const sourceStat = fs.statSync(sourceFilePath);
  const outStat = fs.statSync(outAssetPath);
  return sourceStat.mtime > outStat.mtime;
}

async function compileNonPyFileAsAsset(
  filePath: string,
  srcPath: string,
  mpyPath: string,
  execPromise: (cmd: string) => Promise<string>
): Promise<string> {
  const source = fs.readFileSync(filePath);
  const relativeFromSrc = path.relative(srcPath, filePath).replace(/\\/g, '/');
  const outPath = getAssetOutputPath(filePath, srcPath, mpyPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const payloadB64 = source.toString('base64');
  const wrapperCode = [
    `# Auto-generated by MPyTools from "${relativeFromSrc}"`,
    'import ubinascii as _b',
    `SOURCE_PATH = "${relativeFromSrc}"`,
    `PAYLOAD_B64 = "${payloadB64}"`,
    '',
    'def get_bytes():',
    '    return _b.a2b_base64(PAYLOAD_B64)',
    '',
    "def get_text(encoding='utf-8'):",
    '    return get_bytes().decode(encoding)',
    ''
  ].join('\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpytools-asset-'));
  const tempPyFile = path.join(tempDir, 'asset_wrapper.py');
  fs.writeFileSync(tempPyFile, wrapperCode, 'utf-8');

  try {
    await execPromise(`mpy-cross "${tempPyFile}" -o "${outPath}"`);
    return outPath;
  } finally {
    if (fs.existsSync(tempPyFile)) {
      fs.unlinkSync(tempPyFile);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  }
}

/**
 * Перевіряє, чи два файли ідентичні (швидка перевірка розміру + детальне порівняння, якщо треба).
 */
function areFilesIdentical(fileA: string, fileB: string): boolean {
  try {
    const statA = fs.statSync(fileA);
    const statB = fs.statSync(fileB);
    if (statA.size !== statB.size) {
      return false; // різні розміри => точно різні
    }
    const bufA = fs.readFileSync(fileA);
    const bufB = fs.readFileSync(fileB);
    return bufA.equals(bufB);
  } catch {
    return false;
  }
}

/**
 * Підраховує розмір тек у KB (рекурсивно).
 */
function getFolderSizeKB(dirPath: string): number {
  let totalSize = 0;
  function recurse(folder: string) {
    if (!fs.existsSync(folder)) {
      return;
    }
    const files = fs.readdirSync(folder);
    for (const file of files) {
      const fullPath = path.join(folder, file);
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        recurse(fullPath);
      } else {
        totalSize += stats.size;
      }
    }
  }
  recurse(dirPath);
  return totalSize / 1024;
}
