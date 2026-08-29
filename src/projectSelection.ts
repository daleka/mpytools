import * as path from 'path';

export interface ProjectCandidate<T> {
  value: T;
  rootPath: string;
  hasSourceDirectory: boolean;
}

export interface ProjectCandidateResolution<T> {
  selected?: ProjectCandidate<T>;
  choices: ProjectCandidate<T>[];
}

export type ProjectEntryPoint = 'python' | 'bytecode';

/**
 * Resolve the project that owns the active file. If the editor is not backed
 * by a workspace file, prefer the only valid MPyTools project and otherwise
 * return the candidates that must be shown to the user.
 */
export function resolveProjectCandidate<T>(
  candidates: readonly ProjectCandidate<T>[],
  activeFilePath?: string
): ProjectCandidateResolution<T> {
  if (candidates.length === 0) {
    return { choices: [] };
  }

  if (activeFilePath) {
    const containing = candidates
      .filter((candidate) => isPathInside(candidate.rootPath, activeFilePath))
      .sort((left, right) => path.resolve(right.rootPath).length - path.resolve(left.rootPath).length);
    if (containing.length > 0) {
      return { selected: containing[0], choices: [] };
    }
  }

  if (candidates.length === 1) {
    return { selected: candidates[0], choices: [] };
  }

  const sourceProjects = candidates.filter((candidate) => candidate.hasSourceDirectory);
  if (sourceProjects.length === 1) {
    return { selected: sourceProjects[0], choices: [] };
  }

  return {
    choices: sourceProjects.length > 0 ? sourceProjects : [...candidates]
  };
}

export function resolveProjectEntryPoint(hasMainPy: boolean, hasMainMpy: boolean): ProjectEntryPoint {
  if (hasMainPy && hasMainMpy) {
    throw new Error('Both src/main.py and src/main.mpy exist. Keep exactly one project entry point.');
  }
  if (!hasMainPy && !hasMainMpy) {
    throw new Error('Project entry point not found: expected src/main.py or src/main.mpy.');
  }
  return hasMainPy ? 'python' : 'bytecode';
}

export function conflictingProjectEntryPoint(entryPoint: ProjectEntryPoint): 'main.py' | 'main.mpy' {
  return entryPoint === 'python' ? 'main.mpy' : 'main.py';
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
