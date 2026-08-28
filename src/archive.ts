import * as fs from 'fs';
import * as path from 'path';
import * as yazl from 'yazl';

/** Create a ZIP without relying on platform-specific shell tools. */
export function createZipArchive(sourceFolderPath: string, destinationPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    try {
      addDirectoryToZip(archive, sourceFolderPath, 'src');
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const destination = fs.createWriteStream(destinationPath, { flags: 'wx' });
    let destinationCreated = false;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      destination.destroy();
      if (destinationCreated) {
        try {
          fs.rmSync(destinationPath, { force: true });
        } catch {
          // Preserve the original archive error.
        }
      }
      reject(error);
    };

    destination.once('open', () => {
      destinationCreated = true;
      archive.outputStream.pipe(destination);
      archive.end();
    });
    destination.once('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    destination.once('error', fail);
    archive.outputStream.once('error', fail);
  });
}

function addDirectoryToZip(archive: yazl.ZipFile, sourcePath: string, archivePath: string): void {
  const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
  if (entries.length === 0) {
    archive.addEmptyDirectory(archivePath);
    return;
  }
  for (const entry of entries) {
    const localPath = path.join(sourcePath, entry.name);
    const entryArchivePath = path.posix.join(archivePath, entry.name);
    if (entry.isDirectory()) {
      addDirectoryToZip(archive, localPath, entryArchivePath);
    } else if (entry.isFile()) {
      archive.addFile(localPath, entryArchivePath);
    }
    // Symlinks and special files are deliberately excluded from project archives.
  }
}
