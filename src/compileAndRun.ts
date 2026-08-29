//compileAndRun.ts 

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { prepareFirmwareVersion, saveFirmwareSnapshot } from './projectBuild';
import { DeviceSession } from './deviceSession';
import {
  assertUniqueOutputPaths,
  BuildOutputLocation,
  BuildStoragePaths,
  clearBuildStorage,
  collectSourceInventory,
  DEFAULT_WRAPPABLE_ASSET_EXTENSIONS,
  ensureParentDirectories,
  estimateUploadTimeoutMs,
  isRootStartupPythonFile,
  normalizeAssetExtensions,
  resolveBuildStoragePaths
} from './buildWorkspace';
import {
  conflictingProjectEntryPoint,
  ProjectEntryPoint,
  resolveProjectEntryPoint
} from './projectSelection';
import { resolveWorkspaceProjectFolder } from './workspaceProject';
 

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
 * @param getCompilationTarget  - параметри ABI, які інвалідовують кеш збірки
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
  getCompilationTarget: () => {
    bytecodeVersion?: number;
    architecture?: string;
    smallIntBits?: number;
  }
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

  // Once VS Code's Output cursor is on its last line, the Output view follows
  // appended content natively. Avoid issuing a UI command for every log line:
  // that floods the shared Extension Host on larger projects.
  function logBuildLine(message: string): void {
    outputChannel.appendLine(message);
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
    const workspaceFolder = await resolveWorkspaceProjectFolder('Select the project to compile and upload');
    if (!workspaceFolder) {
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder opened.');
      } else {
        vscode.window.showWarningMessage('Compilation canceled: no project selected.');
      }
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
    const workspaceRoot = workspaceFolder.uri.fsPath;
    const srcPath = path.join(workspaceRoot, 'src');
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isDirectory()) {
      vscode.window.showErrorMessage(`Source folder does not exist: ${srcPath}`);
      return;
    }
    let entryPoint: ProjectEntryPoint;
    const mainPyPath = path.join(srcPath, 'main.py');
    const mainMpyPath = path.join(srcPath, 'main.mpy');
    const hasMainPy = fs.existsSync(mainPyPath) && fs.statSync(mainPyPath).isFile();
    const hasMainMpy = fs.existsSync(mainMpyPath) && fs.statSync(mainMpyPath).isFile();
    try {
      entryPoint = resolveProjectEntryPoint(hasMainPy, hasMainMpy);
    } catch (error: any) {
      vscode.window.showErrorMessage(error.message ?? String(error));
      return;
    }
    const buildStorage = resolveBuildStoragePaths(
      workspaceRoot,
      context.storageUri?.fsPath,
      context.globalStorageUri.fsPath,
      vscode.workspace
        .getConfiguration('mpytools', workspaceFolder.uri)
        .get<BuildOutputLocation>('buildOutputLocation', 'extensionStorage')
    );
    const mpyPath = buildStorage.build;
    const wrappersPath = buildStorage.wrappers;
    const configuredAssetExtensions = vscode.workspace
      .getConfiguration('mpytools', workspaceFolder.uri)
      .get<string[]>('wrappableAssetExtensions', [...DEFAULT_WRAPPABLE_ASSET_EXTENSIONS]);
    const buildConfiguration = {
      extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
      compilationMethod: currentMethod,
      wrapNonPy: shouldWrapNonPy,
      wrappableAssetExtensions: [...normalizeAssetExtensions(configuredAssetExtensions)].sort(),
      buildOutputLocation: buildStorage.location,
      target: getCompilationTarget()
    };

    let preparedVersion;
    try {
      preparedVersion = await prepareFirmwareVersion(workspaceRoot, outputChannel);
    } catch (error: any) {
      const message = `Firmware version generation failed: ${error.message}`;
      outputChannel.show(false);
      logBuildLine(`❌ ${message}`);
      vscode.window.showErrorMessage(message);
      return;
    }

    const cacheMatchesConfiguration = await isBuildCacheCompatible(buildStorage.root, buildConfiguration);
    if (shouldResetMpyFolder || !cacheMatchesConfiguration) {
      await clearBuildStorage(buildStorage);
      logBuildLine(
        shouldResetMpyFolder
          ? '🗑 Cleared MPyTools build cache after device/settings selection.'
          : '🗑 Cleared MPyTools build cache because its configuration or device ABI changed.'
      );
    }
    await fs.promises.mkdir(buildStorage.root, { recursive: true });
    await writeBuildCacheManifest(buildStorage.root, buildConfiguration);

    await deviceSession.closeInteractiveTerminal();

    await showBuildOutputAtEnd(outputChannel);
    logBuildLine("🔹 Starting Compile & Run...");
    logBuildLine(`   - Selected method: ${currentMethod === 'none' ? 'No Compilation' : 'Optimization O' + currentMethod}`);
    logBuildLine(`   - Non-.py mode: ${shouldWrapNonPy ? 'Wrap into .py' : 'Keep as-is'}`);
    logBuildLine(`   - Build output: ${buildStorage.build}`);
    logBuildLine(
      buildStorage.location === 'workspace'
        ? '   - Build mode: visible workspace mpy/ (MPyTools owns and prunes this folder)'
        : '   - Build mode: protected VS Code extension storage'
    );

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
      const reportProgress = createThrottledProgressReporter(progress);
      let compiledCount = 0;
      let wrappedNonPyCount = 0;
      let copiedNonPyCount = 0;
      let copiedPyCount = 0;
      const buildErrors: string[] = [];
      const expectedBuildFiles = new Set<string>();
      const expectedWrapperFiles = new Set<string>();

      if (currentMethod !== 'none') {
        // --- Компіляційний режим ---
        reportProgress('Preparing compilation...', true);
        logBuildLine("🔹 Preparing compilation...");
        await Promise.all([
          fs.promises.mkdir(mpyPath, { recursive: true }),
          fs.promises.mkdir(wrappersPath, { recursive: true })
        ]);

        const inventory = await collectSourceInventory(srcPath, configuredAssetExtensions);
        // MicroPython's standard boot sequence opens boot.py and main.py by
        // filename. Keep these two root entry scripts as source even when all
        // importable project modules are compiled to .mpy.
        const startupPythonFiles = inventory.pythonFiles.filter((filePath) =>
          isRootStartupPythonFile(srcPath, filePath)
        );
        const pythonFiles = inventory.pythonFiles.filter((filePath) =>
          !isRootStartupPythonFile(srcPath, filePath)
        );
        const filesToWrap = shouldWrapNonPy ? inventory.wrappableAssetFiles : [];
        const filesToCopy = shouldWrapNonPy
          ? inventory.rawAssetFiles
          : [...inventory.wrappableAssetFiles, ...inventory.rawAssetFiles];
        const filesToWrapSet = new Set(filesToWrap);
        const nonPythonFiles = [...filesToWrap, ...filesToCopy];
        logBuildLine(
          `   🔹 Source inventory: ${pythonFiles.length} Python, ${filesToWrap.length} wrappable assets, `
          + `${filesToCopy.length} raw assets, ${inventory.ignoredEntries.length} ignored cache/generated entries.`
        );

        const plannedBuildFiles = [
          ...pythonFiles.map((filePath) => {
            const relative = path.relative(srcPath, filePath).replace(/\.py$/u, '.mpy');
            return path.join(mpyPath, relative);
          }),
          ...startupPythonFiles.map((filePath) => getRawOutputPath(filePath, srcPath, mpyPath)),
          ...nonPythonFiles.map((filePath) => filesToWrapSet.has(filePath)
            ? getAssetOutputPath(filePath, srcPath, mpyPath)
            : getRawOutputPath(filePath, srcPath, mpyPath))
        ];
        assertUniqueOutputPaths(plannedBuildFiles);
        plannedBuildFiles.forEach((filePath) => expectedBuildFiles.add(filePath));
        filesToWrap.forEach((filePath) => expectedWrapperFiles.add(
          getAssetWrapperPyPath(filePath, srcPath, wrappersPath)
        ));
        await ensureParentDirectories([
          ...expectedBuildFiles,
          ...expectedWrapperFiles
        ]);
        for (const filePath of startupPythonFiles) {
          const shortName = path.relative(workspaceRoot, filePath);
          const outPath = getRawOutputPath(filePath, srcPath, mpyPath);
          if (needsFileCopy(filePath, outPath)) {
            await copyWithMkDir(filePath, outPath);
            copiedPyCount++;
            logBuildLine(`   🔹 Preserved startup source: ${shortName}`);
          } else {
            logBuildLine(`   🔹 Skipped (unchanged startup source): ${shortName}`);
          }
        }
        const pythonFilesToCompile: string[] = [];

        for (const filePath of pythonFiles) {
          const shortName = path.relative(workspaceRoot, filePath);
          if (needsRecompile(filePath, srcPath, mpyPath)) {
            pythonFilesToCompile.push(filePath);
          } else {
            logBuildLine(`   🔹 Skipped (unchanged .py): ${shortName}`);
            logBuildLine("");
          }
        }

        const compileConcurrency = Math.max(1, Math.min(4, os.cpus().length));
        if (pythonFilesToCompile.length > 0) {
          logBuildLine(
            `   ⚡ Compiling ${pythonFilesToCompile.length} .py files with up to ${compileConcurrency} native workers.`
          );
        }
        await forEachWithConcurrency(
          pythonFilesToCompile,
          compileConcurrency,
          async (filePath) => {
            const shortName = path.relative(workspaceRoot, filePath);
            reportProgress(`Compiling: ${shortName}`);
            logBuildLine(`   🔹 Compiling: ${shortName}`);
            try {
              await compilePyFile(filePath, srcPath, mpyPath);
              compiledCount++;
              logBuildLine(`      ✅ OK: ${shortName}`);
            } catch (err: any) {
              buildErrors.push(`${shortName}: ${err.message ?? err}`);
              logBuildLine(`      ❌ Compilation error: ${shortName} -> ${err.message}`);
            }
            logBuildLine("");
          }
        );

        // Asset wrapping remains sequential and output collisions are rejected above.
        for (const filePath of nonPythonFiles) {
          const shortName = path.relative(workspaceRoot, filePath);
          if (filesToWrapSet.has(filePath)) {
            const outAssetPath = getAssetOutputPath(filePath, srcPath, mpyPath);
            const shouldWrap = needsAssetRecompile(filePath, outAssetPath);
            if (shouldWrap) {
              reportProgress(`Wrapping+compiling asset: ${shortName}`);
              logBuildLine(`   🔹 Wrapping+compiling asset: ${shortName}`);
              try {
                await compileNonPyFileAsAsset(
                  filePath,
                  srcPath,
                  mpyPath,
                  wrappersPath,
                  compileFileToOutput
                );
                wrappedNonPyCount++;
                logBuildLine(`      ✅ OK: ${shortName} -> ${outAssetPath}`);
                logBuildLine(`      ℹ️ Wrapper: ${getAssetWrapperPyPath(filePath, srcPath, wrappersPath)}`);
              } catch (err: any) {
                buildErrors.push(`${shortName}: ${err.message ?? err}`);
                logBuildLine(`      ❌ Asset wrapping/compilation error: ${shortName} -> ${err.message}`);
              }
            } else {
              logBuildLine(`   🔹 Skipped (unchanged wrapped asset): ${shortName}`);
            }
          } else {
            const outRawPath = getRawOutputPath(filePath, srcPath, mpyPath);
            if (needsFileCopy(filePath, outRawPath)) {
              reportProgress(`Copying raw asset: ${shortName}`);
              logBuildLine(`   🔹 Copying raw asset: ${shortName}`);
              await copyWithMkDir(filePath, outRawPath);
              copiedNonPyCount++;
              logBuildLine(`      ✅ OK: ${shortName}`);
            } else {
              logBuildLine(`   🔹 Skipped (unchanged raw asset): ${shortName}`);
            }
            logBuildLine("");
          }
        }
        if (shouldWrapNonPy) {
          logBuildLine(
            `   ✅ Compiled ${compiledCount} .py files; Preserved ${startupPythonFiles.length} startup scripts; `
            + `Wrapped+compiled ${wrappedNonPyCount} assets; `
            + `Copied ${copiedNonPyCount} other assets as-is.`
          );
        } else {
          logBuildLine(
            `   ✅ Compiled ${compiledCount} .py files; Preserved ${startupPythonFiles.length} startup scripts; `
            + `Copied ${copiedNonPyCount} non-py files as-is.`
          );
        }
        if (buildErrors.length > 0) {
          throw new Error(`Compilation failed for ${buildErrors.length} file(s):\n${buildErrors.join('\n')}`);
        }
      } else {
        // --- Режим "No Compilation" ---
        reportProgress('Preparing files without compilation...', true);
        logBuildLine("🔹 No compilation selected. Preparing files in 'mpy'...");
        await fs.promises.mkdir(mpyPath, { recursive: true });
        const inventory = await collectSourceInventory(srcPath, configuredAssetExtensions);
        const filesToWrap = shouldWrapNonPy ? inventory.wrappableAssetFiles : [];
        const filesToWrapSet = new Set(filesToWrap);
        const filesToCopy = shouldWrapNonPy
          ? inventory.rawAssetFiles
          : [...inventory.wrappableAssetFiles, ...inventory.rawAssetFiles];
        const allFiles = [...inventory.pythonFiles, ...filesToWrap, ...filesToCopy];
        logBuildLine(
          `   🔹 Source inventory: ${inventory.pythonFiles.length} Python, ${filesToWrap.length} wrappable assets, `
          + `${filesToCopy.length} raw assets, ${inventory.ignoredEntries.length} ignored cache/generated entries.`
        );
        const plannedBuildFiles = allFiles.map((filePath) => {
          const isPython = path.extname(filePath).toLowerCase() === '.py';
          return !isPython && filesToWrapSet.has(filePath)
            ? getAssetPyOutputPath(filePath, srcPath, mpyPath)
            : getRawOutputPath(filePath, srcPath, mpyPath);
        });
        assertUniqueOutputPaths(plannedBuildFiles);
        plannedBuildFiles.forEach((filePath) => expectedBuildFiles.add(filePath));
        await ensureParentDirectories(expectedBuildFiles);
        for (let i = 0; i < allFiles.length; i++) {
          const filePath = allFiles[i];
          const shortName = path.relative(workspaceRoot, filePath);
          const extName = path.extname(filePath).toLowerCase();
          if (extName === '.py') {
            const outPyPath = getRawOutputPath(filePath, srcPath, mpyPath);
            if (needsFileCopy(filePath, outPyPath)) {
              reportProgress(`Copying .py: ${shortName}`);
              await copyWithMkDir(filePath, outPyPath);
              copiedPyCount++;
              logBuildLine(`   🔹 Copied .py: ${shortName}`);
            } else {
              logBuildLine(`   🔹 Skipped (unchanged .py): ${shortName}`);
            }
          } else if (filesToWrapSet.has(filePath)) {
            const outWrappedPyPath = getAssetPyOutputPath(filePath, srcPath, mpyPath);
            if (needsFileCopy(filePath, outWrappedPyPath)) {
              reportProgress(`Wrapping asset to .py: ${shortName}`);
              await writeNonPyAssetPy(filePath, srcPath, outWrappedPyPath);
              wrappedNonPyCount++;
              logBuildLine(`   🔹 Wrapped asset to .py: ${shortName} -> ${outWrappedPyPath}`);
            } else {
              logBuildLine(`   🔹 Skipped (unchanged wrapped .py asset): ${shortName}`);
            }
          } else {
            const outRawPath = getRawOutputPath(filePath, srcPath, mpyPath);
            if (needsFileCopy(filePath, outRawPath)) {
              reportProgress(`Copying raw asset: ${shortName}`);
              await copyWithMkDir(filePath, outRawPath);
              copiedNonPyCount++;
              logBuildLine(`   🔹 Copied raw asset: ${shortName}`);
            } else {
              logBuildLine(`   🔹 Skipped (unchanged raw asset): ${shortName}`);
            }
          }
        }
        if (shouldWrapNonPy) {
          logBuildLine(
            `   ✅ Copied ${copiedPyCount} .py files; Wrapped ${wrappedNonPyCount} assets into .py; `
            + `Copied ${copiedNonPyCount} other assets as-is.`
          );
        } else {
          logBuildLine(`   ✅ Copied ${copiedPyCount} .py files; Copied ${copiedNonPyCount} non-py files as-is.`);
        }
      }

      await pruneOwnedDirectory(buildStorage, mpyPath, expectedBuildFiles);
      await pruneOwnedDirectory(buildStorage, wrappersPath, expectedWrapperFiles);

      // 2.6 Копіюємо файли на пристрій
      let copyPath: string;
      copyPath = os.platform() === 'win32' ? `${mpyPath}\\.` : `${mpyPath}/.`;

      const transferStats = await getFolderTransferStats(mpyPath);
      const uploadTimeoutMs = estimateUploadTimeoutMs(transferStats.totalBytes, transferStats.fileCount);

      logBuildLine("🔹 Copying files to device...");
      logBuildLine('   - Differential upload: unchanged device files are skipped by hash.');
      logBuildLine(
        `   - Payload: ${(transferStats.totalBytes / 1024).toFixed(2)} KB in ${transferStats.fileCount} files`
      );
      logBuildLine(`   - Upload timeout: ${Math.ceil(uploadTimeoutMs / 1_000)} seconds`);
      try {
        await deviceSession.run(['fs', 'cp', '-r', copyPath, ':/'], { timeoutMs: uploadTimeoutMs });
        vscode.window.showInformationMessage('Copy complete.');
        logBuildLine("   ✅ Copy complete.");
      } catch (err: any) {
        const message = err.message ?? String(err);
        vscode.window.showErrorMessage(`Error copying files: ${message}`);
        logBuildLine(`   ❌ Error copying files: ${message}`);
        compileStatusBarItem.text = '$(rocket)Compile&Run';
        compileStatusBarItem.color = '#00BFFF';
        return;
      }

      // A previous project may have used the other entry-point format. Remove
      // only that conflicting root file so an old main cannot shadow the
      // project that was just uploaded; all other device data is preserved.
      const conflictingEntryPoint = conflictingProjectEntryPoint(entryPoint);
      try {
        await removeRemoteFileIfPresent(deviceSession, conflictingEntryPoint);
        logBuildLine(`   🧹 Removed stale conflicting entry point if present: /${conflictingEntryPoint}`);
      } catch (error: any) {
        throw new Error(`Could not remove stale /${conflictingEntryPoint}: ${error.message ?? error}`);
      }

      if (preparedVersion) {
        try {
          const snapshot = saveFirmwareSnapshot(workspaceRoot, preparedVersion);
          if (snapshot?.created) {
            logBuildLine(`   🛟 Local build snapshot: ${snapshot.path}`);
            vscode.window.showInformationMessage(
              `Firmware ${preparedVersion.version} saved locally in .save/mpytools-builds.`
            );
          } else if (snapshot) {
            logBuildLine(`   🛟 Local build snapshot already exists: ${snapshot.path}`);
          }
        } catch (error: any) {
          const message = `Could not save local build snapshot: ${error.message}`;
          logBuildLine(`   ⚠️ ${message}`);
          vscode.window.showWarningMessage(message);
        }
      }

      // 2.7 (Опційно) Оцінимо розмір скопійованої теки
      logBuildLine(`🔹 Total size of uploaded folder: ${(transferStats.totalBytes / 1024).toFixed(2)} KB`);
      logBuildLine(
        entryPoint === 'python'
          ? '🔹 Soft-resetting device; MicroPython will execute /main.py...'
          : '🔹 Soft-resetting device, then importing /main.mpy...'
      );

      // 2.8 Start through MicroPython's normal boot path. A source main.py is
      // executed automatically after Ctrl-D. Precompiled-only projects need a
      // plain import fallback, without requiring any project-specific entry function.
      await deviceSession.openReplAndRestart(
        'MPY Debugging',
        entryPoint === 'bytecode' ? ['import main'] : [],
        workspaceRoot
      );
      });
    } catch (error: any) {
      const message = `Compile & Run failed: ${error.message ?? error}`;
      logBuildLine(`❌ ${message}`);
      vscode.window.showErrorMessage(message);
    } finally {
      compileStatusBarItem.text = '$(rocket)Compile&Run';
      compileStatusBarItem.color = '#00BFFF';
    }
  });

  context.subscriptions.push(disposableCompileAndRun);
  return compileStatusBarItem;
}

async function removeRemoteFileIfPresent(
  deviceSession: DeviceSession,
  remoteFileName: 'main.py' | 'main.mpy'
): Promise<void> {
  const script = [
    'import os',
    'try:',
    `    os.remove(${JSON.stringify(remoteFileName)})`,
    'except OSError:',
    '    pass'
  ].join('\n');
  await deviceSession.run(['exec', script]);
}

async function showBuildOutputAtEnd(outputChannel: vscode.OutputChannel): Promise<void> {
  outputChannel.show(false);

  // OutputChannel.show() is intentionally fire-and-forget in the VS Code API.
  // Yield once so its Output editor is focused, then move its cursor to the
  // final line. Current VS Code versions use that position to release the
  // smart-scroll lock and follow all subsequent appendLine() calls natively.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    await vscode.commands.executeCommand('cursorBottom');
  } catch {
    // Appending still works on VS Code variants where the editor command is
    // unavailable; only the explicit smart-scroll reset is skipped.
  }
}

function createThrottledProgressReporter(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  minimumIntervalMs = 100
): (message: string, force?: boolean) => void {
  let lastReportAt = 0;
  return (message: string, force = false): void => {
    const now = Date.now();
    if (force || now - lastReportAt >= minimumIntervalMs) {
      progress.report({ message });
      lastReportAt = now;
    }
  };
}

const BUILD_CACHE_MANIFEST = 'build-config.json';

async function isBuildCacheCompatible(cacheRoot: string, configuration: unknown): Promise<boolean> {
  try {
    const manifestPath = path.join(cacheRoot, BUILD_CACHE_MANIFEST);
    const stored = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
    return JSON.stringify(stored) === JSON.stringify(configuration);
  } catch {
    return false;
  }
}

async function writeBuildCacheManifest(cacheRoot: string, configuration: unknown): Promise<void> {
  await fs.promises.writeFile(
    path.join(cacheRoot, BUILD_CACHE_MANIFEST),
    `${JSON.stringify(configuration, null, 2)}\n`,
    'utf-8'
  );
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
async function copyWithMkDir(srcFile: string, destFile: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destFile), { recursive: true });
  await fs.promises.copyFile(srcFile, destFile);
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

function getAssetWrapperPyPath(filePath: string, srcPath: string, wrappersPath: string): string {
  const relativeFromSrc = path.relative(srcPath, filePath);
  const ext = path.extname(relativeFromSrc);
  const wrapperRelativePath = ext ? relativeFromSrc.slice(0, -ext.length) + '.py' : `${relativeFromSrc}.py`;
  return path.join(wrappersPath, wrapperRelativePath);
}

/** Remove stale files, but only inside MPyTools' explicitly owned cache directories. */
async function pruneOwnedDirectory(
  buildStorage: BuildStoragePaths,
  directoryRoot: string,
  expectedFiles: Set<string>
): Promise<void> {
  const resolvedRoot = path.resolve(directoryRoot);
  const allowedRoots = new Set([
    path.resolve(buildStorage.build),
    path.resolve(buildStorage.wrappers)
  ]);
  if (!allowedRoots.has(resolvedRoot)) {
    throw new Error(`Refusing to prune a non-MPyTools cache directory: ${resolvedRoot}`);
  }
  const expected = new Set([...expectedFiles].map((file) => path.resolve(file)));

  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(entryPath);
        if ((await fs.promises.readdir(entryPath)).length === 0) {
          await fs.promises.rmdir(entryPath);
        }
      } else if (!expected.has(path.resolve(entryPath))) {
        await fs.promises.unlink(entryPath);
      }
    }
  }

  if (fs.existsSync(resolvedRoot)) {
    await visit(resolvedRoot);
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
  const source = await fs.promises.readFile(filePath);
  const wrapperCode = buildNonPyAssetWrapperCode(filePath, srcPath, source);
  await fs.promises.mkdir(path.dirname(outputPyPath), { recursive: true });
  await fs.promises.writeFile(outputPyPath, wrapperCode, 'utf-8');
}

async function compileNonPyFileAsAsset(
  filePath: string,
  srcPath: string,
  mpyPath: string,
  wrappersPath: string,
  compileFileToOutput: (sourcePath: string, outPath: string) => Promise<string>
): Promise<string> {
  const outPath = getAssetOutputPath(filePath, srcPath, mpyPath);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  const wrapperPyPath = getAssetWrapperPyPath(filePath, srcPath, wrappersPath);
  await writeNonPyAssetPy(filePath, srcPath, wrapperPyPath);
  await compileFileToOutput(wrapperPyPath, outPath);
  return outPath;
}

/**
 * Підраховує розмір тек у KB (рекурсивно).
 */
async function getFolderTransferStats(
  dirPath: string
): Promise<{ totalBytes: number; fileCount: number }> {
  let totalBytes = 0;
  let fileCount = 0;
  async function recurse(folder: string): Promise<void> {
    if (!fs.existsSync(folder)) {
      return;
    }
    const files = await fs.promises.readdir(folder);
    for (const file of files) {
      const fullPath = path.join(folder, file);
      const stats = await fs.promises.stat(fullPath);
      if (stats.isDirectory()) {
        await recurse(fullPath);
      } else {
        totalBytes += stats.size;
        fileCount++;
      }
    }
  }
  await recurse(dirPath);
  return { totalBytes, fileCount };
}
