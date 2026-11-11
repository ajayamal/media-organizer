import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function findEmptyFolders(root: string, categories: string[]): Promise<string[]> {
  const mediaRoot = path.resolve(root);
  const emptyFolders: string[] = [];

  const inspect = async (directory: string, rel: string): Promise<boolean> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    let containsOnlyEmptyFolders = true;

    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) {
        containsOnlyEmptyFolders = false;
        continue;
      }

      const childRel = `${rel}/${entry.name}`;
      const childDirectory = path.join(directory, entry.name);
      if (!await inspect(childDirectory, childRel)) containsOnlyEmptyFolders = false;
    }

    if (containsOnlyEmptyFolders) emptyFolders.push(rel);
    return containsOnlyEmptyFolders;
  };

  for (const category of categories) {
    if (path.isAbsolute(category) || category.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid media category: ${category}`);
    }
    let current = mediaRoot;
    let categoryExists = true;
    const rootStat = await fs.lstat(mediaRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('Media root is not a regular directory.');
    }

    for (const part of category.split('/')) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Media category is not a regular directory: ${category}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          categoryExists = false;
          break;
        }
        throw error;
      }
    }
    if (!categoryExists) continue;

    const categoryRoot = current;
    const entries = await fs.readdir(categoryRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      await inspect(path.join(categoryRoot, entry.name), `${category}/${entry.name}`);
    }
  }

  return emptyFolders.sort((left, right) => left.localeCompare(right));
}

export async function removeEmptyFolders(
  root: string,
  categories: string[],
  requestedFolders: string[],
): Promise<{ removed: string[]; failures: Array<{ rel: string; error: string }> }> {
  if (requestedFolders.length === 0 || requestedFolders.length > 2000
    || new Set(requestedFolders).size !== requestedFolders.length) {
    throw new Error('Select between 1 and 2,000 unique empty folders.');
  }

  const currentEmptyFolders = new Set(await findEmptyFolders(root, categories));
  const staleFolder = requestedFolders.find(folder => !currentEmptyFolders.has(folder));
  if (staleFolder) throw new Error(`Folder is no longer empty or is outside the library: ${staleFolder}`);

  const mediaRoot = path.resolve(root);
  const removed: string[] = [];
  const failures: Array<{ rel: string; error: string }> = [];
  const foldersToRemove = [...currentEmptyFolders].filter(folder =>
    requestedFolders.some(rootFolder => folder === rootFolder || folder.startsWith(`${rootFolder}/`)),
  );
  const deepestFirst = foldersToRemove.sort((left, right) =>
    right.split('/').length - left.split('/').length || left.localeCompare(right),
  );

  for (const rel of deepestFirst) {
    const directory = path.resolve(mediaRoot, rel);
    if (!directory.startsWith(`${mediaRoot}${path.sep}`)) {
      throw new Error(`Invalid empty folder path: ${rel}`);
    }
    try {
      await fs.rmdir(directory);
      removed.push(rel);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      failures.push({
        rel,
        error: code === 'ENOTEMPTY' ? 'Folder is no longer empty.' :
          code === 'ENOENT' ? 'Folder no longer exists.' :
            error instanceof Error ? error.message : 'Unable to remove folder.',
      });
    }
  }

  return { removed, failures };
}
