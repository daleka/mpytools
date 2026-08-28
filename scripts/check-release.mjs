import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sourceFiles = walk(path.join(root, 'src')).filter((file) => file.endsWith('.ts'));
const source = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const problems = [];

for (const file of [...sourceFiles, path.join(root, 'package.json')]) {
  const content = fs.readFileSync(file, 'utf8');
  if (/^(?:<{7}|={7}|>{7})/m.test(content)) {
    problems.push(`merge conflict marker: ${path.relative(root, file)}`);
  }
}

if (/require\(['"]child_process['"]\)\.exec\b|\bexecSync\b|\bshell\s*:\s*true/u.test(source)) {
  problems.push('shell-based child-process execution is forbidden in extension source');
}

const registeredCommands = new Set(
  [...source.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/gu)].map((match) => match[1])
);
for (const contribution of packageJson.contributes?.commands ?? []) {
  if (!registeredCommands.has(contribution.command)) {
    problems.push(`contributed command is not registered: ${contribution.command}`);
  }
}

if (fs.existsSync(path.join(root, 'install-dependencies.sh'))
  || fs.existsSync(path.join(root, 'install-dependencies.ps1'))) {
  problems.push('legacy system-wide dependency installer is still packaged');
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release checks passed (${sourceFiles.length} TypeScript files, ${registeredCommands.size} commands).`);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}
