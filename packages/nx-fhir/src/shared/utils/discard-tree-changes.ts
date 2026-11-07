import { normalizePath, Tree } from '@nx/devkit';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Takes every recorded change back out of the tree, so the generator
 * returns with nothing for Nx to write. A file written back with its disk
 * bytes loses its entry and clears the delete marks of its parents, and a
 * created file deleted again leaves no entry because it never existed on
 * disk.
 */
export function discardTreeChanges(tree: Tree): void {
  for (const change of tree.listChanges()) {
    if (change.type === 'CREATE') {
      tree.delete(change.path);
      continue;
    }
    const onDisk = join(tree.root, change.path);
    // A deleted directory is listed once, so every file under it is written back
    const files = statSync(onDisk).isDirectory()
      ? readdirSync(onDisk, { recursive: true })
          .map((entry) => join(onDisk, String(entry)))
          .filter((path) => statSync(path).isFile())
      : [onDisk];
    for (const file of files) {
      tree.write(normalizePath(relative(tree.root, file)), readFileSync(file));
    }
  }
  // A leftover entry would reach disk when the generator returns, so the
  // run stops instead and Nx writes nothing
  const leftover = tree.listChanges().map((change) => change.path);
  if (leftover.length > 0) {
    throw new Error(
      `The update could not be taken back out of the tree for: ${leftover.join(', ')}`,
    );
  }
}
