import { normalizePath, Tree } from '@nx/devkit';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json'];

// Registry and install settings the package manager reads from the directory
// it runs in, so the copy needs the workspace's when the project has none
const REGISTRY_FILES = ['.npmrc', 'bunfig.toml'];

/**
 * A throwaway copy of a frontend project where an update's dependency
 * versions can be installed and checked without touching the real project.
 */
export interface VerificationCopy {
  dir: string;
  readFile(relativePath: string): Buffer | null;
  dispose(): void;
}

function copyPath(dir: string, relativePath: string): string {
  return join(dir, ...relativePath.split('/'));
}

/**
 * Copies the project directory from disk, then applies every pending change
 * the tree holds under the project root, so the copy matches what Nx would
 * write when the generator flushes. The lockfiles are left out so the
 * install resolves fresh against the given package.json.
 */
export function createVerificationCopy(input: {
  tree: Tree;
  projectRoot: string;
  packageJson: unknown;
}): VerificationCopy {
  const { tree, projectRoot, packageJson } = input;
  const dir = mkdtempSync(join(tmpdir(), 'nx-fhir-verify-'));

  try {
    // Symlinks are dereferenced so a write through a linked path lands in
    // the copy and never in the real project
    cpSync(join(tree.root, projectRoot), dir, {
      recursive: true,
      dereference: true,
      filter: (src) => basename(src) !== 'node_modules',
    });

    const prefix = normalizePath(projectRoot) + '/';
    for (const change of tree.listChanges()) {
      if (!change.path.startsWith(prefix)) {
        continue;
      }
      const target = copyPath(dir, change.path.slice(prefix.length));
      // The tree lists every emptied parent directory as deleted too
      if (change.type === 'DELETE') {
        rmSync(target, { recursive: true, force: true, maxRetries: 5 });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, change.content ?? '');
    }

    // Removed after the overlay so a pending lockfile change cannot bring one back
    for (const lockfile of LOCKFILES) {
      rmSync(join(dir, lockfile), { force: true });
    }

    writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');

    for (const name of REGISTRY_FILES) {
      const workspaceFile = join(tree.root, name);
      if (existsSync(workspaceFile) && !existsSync(join(dir, name))) {
        copyFileSync(workspaceFile, join(dir, name));
      }
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }

  return {
    dir,
    readFile(relativePath) {
      try {
        return readFileSync(copyPath(dir, relativePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
