//compileAndRun.ts 

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { prepareFirmwareVersion, saveFirmwareSnapshot } from './projectBuild';
import { DeviceSession } from './deviceSession';
 

/**
 * Функція реєструє кнопку та команду "mpytools.compileAndRun".
 * Уся логіка (запит оптимізації, компіляція, копіювання, запуск main) перенесена сюди з extension.ts.
 *
 * @param context               - контекст розширення
 * @param outputChannel         - канал виводу
 * @param deviceSession         - єдиний серіалізований доступ до MicroPython пристрою
 * @param getSelectedMethod     - функція-гетер для selectedCompilationMethod
 * @param setSelectedMethod     - функція-сетер для export function registerCompileAndRunCommand(
 * @param needsRecompile        - функція перевірки потреби перекомпіляції
 * @param compilePyFile         - функція компіляції одного .py у .mpy
 * @param compileFileToOutput   - функція компіляції у вказаний вихідний файл
 * @param findPyFiles           - функція пошуку .py в папці src
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
  deviceSession: DeviceSession,
  getSelectedMethod: () => string | undefined,
  setSelectedMethod: (val: string | undefined) => void,
  needsRecompile: (pyFilePath: string, srcPath: string, mpyPath: string) => boolean,
  compilePyFile: (pyFilePath: string, srcPath: string, mpyPath: string) => Promise<string>,
  compileFileToOutput: (sourcePath: string, outPath: string) => Promise<string>,
  findPyFiles: (rootDir: string, ignoreList?: string[]) => string[],
  getMicropythonVersion: () => string | undefined,
  getMicropythonBytecodeVersion: () => number | undefined,
  getMicropythonArchitecture: () => string | undefined,
  getMicropythonMsmallIntBits: () => number | undefined
): vscode.StatusBarItem {
  const wrapNonPySettingKey = 'mpytools.wrapNonPyFiles';
  const compileMethodSettingKey = 'mpytools.compileMethod';
  const compileSettingsDirtyKey = 'mpytools.compileSettingsDirty';
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
    const shouldReconfigure = context.workspaceState.get<boolean>(compileSettingsDirtyKey) === true;
    let currentMethod = context.workspaceState.get<string>(compileMethodSettingKey) ?? getSelectedMethod();
    let shouldWrapNonPy = context.workspaceState.get<boolean>(wrapNonPySettingKey);
    let shouldResetMpyFolder = false;

    if (shouldReconfigure || !currentMethod || shouldWrapNonPy === undefined) {
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
      currentMethod = result.label === 'No Compilation'
        ? 'none'
        : (result.label.match(/Level (\d+)/)?.[1] ?? '0');
      await context.workspaceState.update(compileMethodSettingKey, currentMethod);

      const wrapOptions: vscode.QuickPickItem[] = [
        {
          label: 'ON — Compile non-.py files',
          description: 'Wrap common files (e.g. .html, .js, .css, .json, .txt) into .py and compile/upload'
        },
        {
          label: 'OFF — Do not compile non-.py files',
          description: 'Keep non-.py files as-is and upload them without wrapping/compiling'
        }
      ];
      const wrapResult = await vscode.window.showQuickPick(wrapOptions, {
        placeHolder: 'Choose non-.py handling mode',
        canPickMany: false
      });
      if (!wrapResult) {
        vscode.window.showWarningMessage('Compilation canceled: non-.py mode not selected.');
        return;
      }
      shouldWrapNonPy = wrapResult.label === 'ON — Compile non-.py files';
      await context.workspaceState.update(wrapNonPySettingKey, shouldWrapNonPy);
      await context.workspaceState.update(compileSettingsDirtyKey, false);
      shouldResetMpyFolder = true;
    }
    if (!currentMethod || shouldWrapNonPy === undefined) {
      vscode.window.showWarningMessage('Compilation canceled: settings are not initialized.');
      return;
    }
    setSelectedMethod(currentMethod);

    // 2.4 Підготовчі змінні
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const srcPath = path.join(workspaceRoot, 'src');
    const mpyPath = path.join(workspaceRoot, '.mpytools', 'build');
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isDirectory()) {
      vscode.window.showErrorMessage(`Source folder does not exist: ${srcPath}`);
      return;
    }

    let preparedVersion;
    try {
      preparedVersion = await prepareFirmwareVersion(workspaceRoot, outputChannel);
    } catch (error: any) {
      const message = `Firmware version generation failed: ${error.message}`;
      outputChannel.show(false);
      logAndScroll(`❌ ${message}`);
      vscode.window.showErrorMessage(message);
      return;
    }

    if (shouldResetMpyFolder && fs.existsSync(mpyPath)) {
      fs.rmSync(mpyPath, { recursive: true, force: true });
      logAndScroll("🗑 Cleared MPyTools-owned build folder.");
    }

    await deviceSession.closeInteractiveTerminal();

    outputChannel.show(false);
    logAndScroll("🔹 Starting Compile & Run...");
    logAndScroll(`   - Selected method: ${currentMethod === 'none' ? 'No Compilation' : 'Optimization O' + currentMethod}`);
    logAndScroll(`   - Non-.py mode: ${shouldWrapNonPy ? 'Wrap into .py' : 'Keep as-is'}`);

    // Нова зміна: змінюємо стан кнопки на активний – червоний із спінером
    compileStatusBarItem.text = '$(sync~spin)Compile&Run';
    compileStatusBarItem.color = 'red';

    // 2.5 Основний процес з індикацією Progress
    try {
      await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'MPyTools: Compile & Run',
      cancellable: false
    }, async (progress) => {
      let compiledCount = 0;
      let wrappedNonPyCount = 0;
      let copiedNonPyCount = 0;
      let copiedPyCount = 0;
      const buildErrors: string[] = [];
      const expectedBuildFiles = new Set<string>();

      if (currentMethod !== 'none') {
        // --- Компіляційний режим ---
        progress.report({ message: 'Preparing compilation...' });
        logAndScroll("🔹 Preparing compilation...");
        if (!fs.existsSync(mpyPath)) {
          fs.mkdirSync(mpyPath, { recursive: true });
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

        const pythonFiles = allFiles.filter((filePath) => path.extname(filePath).toLowerCase() === '.py');
        const nonPythonFiles = allFiles.filter((filePath) => path.extname(filePath).toLowerCase() !== '.py');
        for (const filePath of pythonFiles) {
          const relative = path.relative(srcPath, filePath).replace(/\.py$/u, '.mpy');
          expectedBuildFiles.add(path.join(mpyPath, relative));
        }
        for (const filePath of nonPythonFiles) {
          expectedBuildFiles.add(shouldWrapNonPy
            ? getAssetOutputPath(filePath, srcPath, mpyPath)
            : getRawOutputPath(filePath, srcPath, mpyPath));
        }
        const pythonFilesToCompile: string[] = [];

        for (const filePath of pythonFiles) {
          const shortName = path.relative(workspaceRoot, filePath);
          if (needsRecompile(filePath, srcPath, mpyPath)) {
            pythonFilesToCompile.push(filePath);
          } else {
            logAndScroll(`   🔹 Skipped (unchanged .py): ${shortName}`);
            logAndScroll("");
          }
        }

        const compileConcurrency = Math.max(1, Math.min(4, os.cpus().length));
        if (pythonFilesToCompile.length > 0) {
          logAndScroll(
            `   ⚡ Compiling ${pythonFilesToCompile.length} .py files with up to ${compileConcurrency} native workers.`
          );
        }
        await forEachWithConcurrency(
          pythonFilesToCompile,
          compileConcurrency,
          async (filePath) => {
            const shortName = path.relative(workspaceRoot, filePath);
            progress.report({ message: `Compiling: ${shortName}` });
            logAndScroll(`   🔹 Compiling: ${shortName}`);
            try {
              await compilePyFile(filePath, srcPath, mpyPath);
              compiledCount++;
              logAndScroll(`      ✅ OK: ${shortName}`);
            } catch (err: any) {
              buildErrors.push(`${shortName}: ${err.message ?? err}`);
              logAndScroll(`      ❌ Compilation error: ${shortName} -> ${err.message}`);
            }
            logAndScroll("");
          }
        );

        // Assets remain sequential: different extensions may intentionally map to the same wrapper name.
        for (const filePath of nonPythonFiles) {
          const shortName = path.relative(workspaceRoot, filePath);
          if (shouldWrapNonPy) {
            const outAssetPath = getAssetOutputPath(filePath, srcPath, mpyPath);
            const shouldWrap = needsAssetRecompile(filePath, outAssetPath);
            if (shouldWrap) {
              progress.report({ message: `Wrapping+compiling asset: ${shortName}` });
              logAndScroll(`   🔹 Wrapping+compiling asset: ${shortName}`);
              try {
                await compileNonPyFileAsAsset(filePath, srcPath, mpyPath, compileFileToOutput);
                wrappedNonPyCount++;
                logAndScroll(`      ✅ OK: ${shortName} -> ${path.relative(workspaceRoot, outAssetPath)}`);
                logAndScroll(`      ℹ️ Wrapper: ${path.relative(workspaceRoot, getAssetWrapperPyPath(filePath, srcPath))}`);
              } catch (err: any) {
                buildErrors.push(`${shortName}: ${err.message ?? err}`);
                logAndScroll(`      ❌ Asset wrapping/compilation error: ${shortName} -> ${err.message}`);
              }
            } else {
              logAndScroll(`   🔹 Skipped (unchanged wrapped asset): ${shortName}`);
            }
          } else {
            const outRawPath = getRawOutputPath(filePath, srcPath, mpyPath);
            if (needsFileCopy(filePath, outRawPath)) {
              progress.report({ message: `Copying raw asset: ${shortName}` });
              logAndScroll(`   🔹 Copying raw asset: ${shortName}`);
              copyWithMkDir(filePath, outRawPath);
              copiedNonPyCount++;
              logAndScroll(`      ✅ OK: ${shortName}`);
            } else {
              logAndScroll(`   🔹 Skipped (unchanged raw asset): ${shortName}`);
            }
            logAndScroll("");
          }
        }
        if (shouldWrapNonPy) {
          logAndScroll(`   ✅ Compiled ${compiledCount} .py files; Wrapped+compiled ${wrappedNonPyCount} non-py files.`);
        } else {
          logAndScroll(`   ✅ Compiled ${compiledCount} .py files; Copied ${copiedNonPyCount} non-py files as-is.`);
        }
        if (buildErrors.length > 0) {
          throw new Error(`Compilation failed for ${buildErrors.length} file(s):\n${buildErrors.join('\n')}`);
        }
      } else {
        // --- Режим "No Compilation" ---
        progress.report({ message: 'Preparing files in mpy without compilation...' });
        logAndScroll("🔹 No compilation selected. Preparing files in 'mpy'...");
        if (!fs.existsSync(mpyPath)) {
          fs.mkdirSync(mpyPath, { recursive: true });
          logAndScroll(`   ✅ Created directory: ${mpyPath}`);
        }
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
        for (const filePath of allFiles) {
          const isPython = path.extname(filePath).toLowerCase() === '.py';
          expectedBuildFiles.add(isPython || !shouldWrapNonPy
            ? getRawOutputPath(filePath, srcPath, mpyPath)
            : getAssetPyOutputPath(filePath, srcPath, mpyPath));
        }
        for (let i = 0; i < allFiles.length; i++) {
          const filePath = allFiles[i];
          const shortName = path.relative(workspaceRoot, filePath);
          const extName = path.extname(filePath).toLowerCase();
          if (extName === '.py') {
            const outPyPath = getRawOutputPath(filePath, srcPath, mpyPath);
            if (needsFileCopy(filePath, outPyPath)) {
              progress.report({ message: `Copying .py: ${shortName}` });
              copyWithMkDir(filePath, outPyPath);
              copiedPyCount++;
              logAndScroll(`   🔹 Copied .py: ${shortName}`);
            } else {
              logAndScroll(`   🔹 Skipped (unchanged .py): ${shortName}`);
            }
          } else if (shouldWrapNonPy) {
            const outWrappedPyPath = getAssetPyOutputPath(filePath, srcPath, mpyPath);
            if (needsFileCopy(filePath, outWrappedPyPath)) {
              progress.report({ message: `Wrapping asset to .py: ${shortName}` });
              await writeNonPyAssetPy(filePath, srcPath, outWrappedPyPath);
              wrappedNonPyCount++;
              logAndScroll(`   🔹 Wrapped asset to .py: ${shortName} -> ${path.relative(workspaceRoot, outWrappedPyPath)}`);
            } else {
              logAndScroll(`   🔹 Skipped (unchanged wrapped .py asset): ${shortName}`);
            }
          } else {
            const outRawPath = getRawOutputPath(filePath, srcPath, mpyPath);
            if (needsFileCopy(filePath, outRawPath)) {
              progress.report({ message: `Copying raw asset: ${shortName}` });
              copyWithMkDir(filePath, outRawPath);
              copiedNonPyCount++;
              logAndScroll(`   🔹 Copied raw asset: ${shortName}`);
            } else {
              logAndScroll(`   🔹 Skipped (unchanged raw asset): ${shortName}`);
            }
          }
        }
        if (shouldWrapNonPy) {
          logAndScroll(`   ✅ Copied ${copiedPyCount} .py files; Wrapped ${wrappedNonPyCount} non-py files into .py.`);
        } else {
          logAndScroll(`   ✅ Copied ${copiedPyCount} .py files; Copied ${copiedNonPyCount} non-py files as-is.`);
        }
      }

      pruneBuildDirectory(mpyPath, expectedBuildFiles);

      // 2.6 Копіюємо файли на пристрій
      let copyPath: string;
      copyPath = os.platform() === 'win32' ? `${mpyPath}\\.` : `${mpyPath}/.`;

      logAndScroll("🔹 Copying files to device...");
      try {
        await deviceSession.run(['fs', 'cp', '-r', copyPath, ':/'], { timeoutMs: 120_000 });
        vscode.window.showInformationMessage('Copy complete.');
        logAndScroll("   ✅ Copy complete.");
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error copying files: ${err}`);
        logAndScroll(`   ❌ Error copying files: ${err.message}`);
        compileStatusBarItem.text = '$(rocket)Compile&Run';
        compileStatusBarItem.color = '#00BFFF';
        return;
      }

      if (preparedVersion) {
        try {
          const snapshot = saveFirmwareSnapshot(workspaceRoot, preparedVersion);
          if (snapshot?.created) {
            logAndScroll(`   🛟 Local build snapshot: ${snapshot.path}`);
            vscode.window.showInformationMessage(
              `Firmware ${preparedVersion.version} saved locally in .save/mpytools-builds.`
            );
          } else if (snapshot) {
            logAndScroll(`   🛟 Local build snapshot already exists: ${snapshot.path}`);
          }
        } catch (error: any) {
          const message = `Could not save local build snapshot: ${error.message}`;
          logAndScroll(`   ⚠️ ${message}`);
          vscode.window.showWarningMessage(message);
        }
      }

      // 2.7 (Опційно) Оцінимо розмір скопійованої теки
      const folderSizeKB = getFolderSizeKB(mpyPath);
      logAndScroll(`🔹 Total size of uploaded folder: ${folderSizeKB.toFixed(2)} KB`);
      logAndScroll("🔹 Launching main...");

      // 2.8 Запускаємо main
      await deviceSession.openRepl(
        'MPY Debugging',
        'import main\nprint("[MPyTools] main.run()")\nmain.run()\n'
      );
      });
    } catch (error: any) {
      const message = `Compile & Run failed: ${error.message ?? error}`;
      logAndScroll(`❌ ${message}`);
      vscode.window.showErrorMessage(message);
    } finally {
      compileStatusBarItem.text = '$(rocket)Compile&Run';
      compileStatusBarItem.color = '#00BFFF';
    }
  });

  context.subscriptions.push(disposableCompileAndRun);
  return compileStatusBarItem;
}

async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) {
        return;
      }
      await worker(items[currentIndex]);
    }
  }
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
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

function getRawOutputPath(filePath: string, srcPath: string, mpyPath: string): string {
  const relativeFromSrc = path.relative(srcPath, filePath);
  return path.join(mpyPath, relativeFromSrc);
}

function getAssetPyOutputPath(filePath: string, srcPath: string, mpyPath: string): string {
  const relativeFromSrc = path.relative(srcPath, filePath);
  const ext = path.extname(relativeFromSrc);
  const withoutExt = ext ? relativeFromSrc.slice(0, -ext.length) : relativeFromSrc;
  return path.join(mpyPath, `${withoutExt}.py`);
}

function getAssetWrapperPyPath(filePath: string, srcPath: string): string {
  const relativeFromSrc = path.relative(srcPath, filePath);
  const ext = path.extname(relativeFromSrc);
  const wrapperRelativePath = ext ? relativeFromSrc.slice(0, -ext.length) + '.py' : `${relativeFromSrc}.py`;
  const workspaceRoot = path.dirname(srcPath);
  return path.join(workspaceRoot, '.mpytools', 'wrappers', wrapperRelativePath);
}

/** Remove stale output files, but only inside MPyTools' explicitly owned build directory. */
function pruneBuildDirectory(buildRoot: string, expectedFiles: Set<string>): void {
  const resolvedRoot = path.resolve(buildRoot);
  if (path.basename(resolvedRoot) !== 'build' || path.basename(path.dirname(resolvedRoot)) !== '.mpytools') {
    throw new Error(`Refusing to prune a non-MPyTools build directory: ${resolvedRoot}`);
  }
  const expected = new Set([...expectedFiles].map((file) => path.resolve(file)));

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(entryPath);
        if (fs.readdirSync(entryPath).length === 0) {
          fs.rmdirSync(entryPath);
        }
      } else if (!expected.has(path.resolve(entryPath))) {
        fs.unlinkSync(entryPath);
      }
    }
  }

  if (fs.existsSync(resolvedRoot)) {
    visit(resolvedRoot);
  }
}

function needsAssetRecompile(sourceFilePath: string, outAssetPath: string): boolean {
  if (!fs.existsSync(outAssetPath)) {
    return true;
  }
  const sourceStat = fs.statSync(sourceFilePath);
  const outStat = fs.statSync(outAssetPath);
  return sourceStat.mtime > outStat.mtime;
}

function needsFileCopy(sourceFilePath: string, outputPath: string): boolean {
  if (!fs.existsSync(outputPath)) {
    return true;
  }
  const sourceStat = fs.statSync(sourceFilePath);
  const outStat = fs.statSync(outputPath);
  return sourceStat.mtime > outStat.mtime;
}

function buildNonPyAssetWrapperCode(filePath: string, srcPath: string, source: Buffer): string {
  const relativeFromSrc = path.relative(srcPath, filePath).replace(/\\/g, '/');
  const payloadB64 = source.toString('base64');
  const b64Chunks: string[] = [];
  for (let i = 0; i < payloadB64.length; i += 256) {
    b64Chunks.push(payloadB64.slice(i, i + 256));
  }
  const b64Tuple = b64Chunks.map((chunk) => JSON.stringify(chunk)).join(',\n    ');
  const textPayload = source.toString('utf-8');
  const isUtf8Text = Buffer.from(textPayload, 'utf-8').equals(source);
  let wrapperCode = [
    `# Auto-generated by MPyTools from "${relativeFromSrc}"`,
    'import ubinascii as _b',
    `SOURCE_PATH = "${relativeFromSrc}"`,
    `_B64_CHUNKS = (\n    ${b64Tuple}\n)`,
    '',
    'def get_bytes():',
    "    return _b.a2b_base64(''.join(_B64_CHUNKS))",
    ''
  ].join('\n');

  if (isUtf8Text) {
    wrapperCode += [
      `def get_text(encoding='utf-8'):`,
      '    return get_bytes().decode(encoding)',
      ''
    ].join('\n');
  }

  return wrapperCode;
}

async function writeNonPyAssetPy(
  filePath: string,
  srcPath: string,
  outputPyPath: string
): Promise<void> {
  const source = fs.readFileSync(filePath);
  const wrapperCode = buildNonPyAssetWrapperCode(filePath, srcPath, source);
  fs.mkdirSync(path.dirname(outputPyPath), { recursive: true });
  fs.writeFileSync(outputPyPath, wrapperCode, 'utf-8');
}

async function compileNonPyFileAsAsset(
  filePath: string,
  srcPath: string,
  mpyPath: string,
  compileFileToOutput: (sourcePath: string, outPath: string) => Promise<string>
): Promise<string> {
  const source = fs.readFileSync(filePath);
  const outPath = getAssetOutputPath(filePath, srcPath, mpyPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const wrapperPyPath = getAssetWrapperPyPath(filePath, srcPath);
  await writeNonPyAssetPy(filePath, srcPath, wrapperPyPath);
  await compileFileToOutput(wrapperPyPath, outPath);
  return outPath;
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
