import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectCandidate, resolveProjectCandidate } from './projectSelection';

interface WorkspaceFolderPickItem extends vscode.QuickPickItem {
  folder: vscode.WorkspaceFolder;
}

export async function resolveWorkspaceProjectFolder(
  placeHolder: string
): Promise<vscode.WorkspaceFolder | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  const candidates: ProjectCandidate<vscode.WorkspaceFolder>[] = workspaceFolders.map((folder) => ({
    value: folder,
    rootPath: folder.uri.fsPath,
    hasSourceDirectory: fs.existsSync(path.join(folder.uri.fsPath, 'src'))
  }));
  const activeDocument = vscode.window.activeTextEditor?.document;
  const activeFilePath = activeDocument?.uri.scheme === 'file' ? activeDocument.uri.fsPath : undefined;
  const resolution = resolveProjectCandidate(candidates, activeFilePath);
  if (resolution.selected) {
    return resolution.selected.value;
  }
  if (resolution.choices.length === 0) {
    return undefined;
  }

  const items: WorkspaceFolderPickItem[] = resolution.choices.map((candidate) => ({
    label: candidate.value.name,
    description: candidate.rootPath,
    detail: candidate.hasSourceDirectory ? 'MPyTools project: src/' : 'No src/ directory',
    folder: candidate.value
  }));
  return (await vscode.window.showQuickPick(items, {
    placeHolder,
    canPickMany: false
  }))?.folder;
}
