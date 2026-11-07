import { detectPackageManager, logger, Tree } from '@nx/devkit';
import { existsSync, rmSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getInstallCommand } from '../utils/package-manager';
import { isRootWorkspaceMember } from '../utils/frontend-integration';

/**
 * Writes the migrated package.json to disk and installs the project's
 * dependencies from a clean lockfile state. A failed install puts the
 * previous manifest, lockfiles, and module tree back.
 */
export async function installDependencies(
  tree: Tree,
  projectRoot: string,
  packageJson: unknown
): Promise<void> {
  const projectPackageJsonPath = `${projectRoot}/package.json`;
  const absolutePackageJsonPath = join(tree.root, projectPackageJsonPath);
  const packageManager = detectPackageManager(tree.root);
  const projectAbsPath = join(tree.root, projectRoot);
  // The install must resolve fresh against the migrated package.json, so the
  // lockfiles and the project node_modules are moved aside and restored if
  // it fails. A root workspace member also resolves from the root lockfile.
  // The root node_modules stays in place because this process runs from it.
  const lockfileDirs = (await isRootWorkspaceMember(tree, projectRoot))
    ? [tree.root, projectAbsPath]
    : [projectAbsPath];
  const lockfileCandidates: Array<{ original: string; backup: string }> =
    [];
  for (const dir of lockfileDirs) {
    for (const lockfile of [
      'bun.lock',
      'bun.lockb',
      'package-lock.json',
    ]) {
      const original = join(dir, lockfile);
      lockfileCandidates.push({
        original,
        backup: `${original}.nx-fhir-backup`,
      });
    }
  }
  const nodeModulesPath = join(projectAbsPath, 'node_modules');
  const nodeModulesBackup = `${nodeModulesPath}.nx-fhir-backup`;

  // A file beside its backup means an earlier run was interrupted, and
  // neither side is known to be the current one
  for (const { original, backup } of [
    ...lockfileCandidates,
    { original: nodeModulesPath, backup: nodeModulesBackup },
  ]) {
    if (existsSync(original) && existsSync(backup)) {
      throw new Error(
        `Found both ${original} and its backup ${backup}, likely left by an interrupted migration. ` +
          'Verify which is current, remove the backup, and run the migration again.'
      );
    }
  }

  // The install needs the migrated package.json on disk now, the tree flush
  // writes the same bytes later. The previous bytes are backed up so a
  // restored lockfile gets back the manifest it was resolved from.
  const packageJsonBackupPath = `${absolutePackageJsonPath}.nx-fhir-backup`;
  // After an interrupted run the backup holds the previous manifest
  const previousPackageJson = existsSync(packageJsonBackupPath)
    ? readFileSync(packageJsonBackupPath)
    : existsSync(absolutePackageJsonPath)
      ? readFileSync(absolutePackageJsonPath)
      : undefined;
  if (previousPackageJson !== undefined) {
    writeFileSync(packageJsonBackupPath, previousPackageJson);
  }
  writeFileSync(absolutePackageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

  const lockfileBackups: Array<{ original: string; backup: string }> =
    [];
  for (const { original, backup } of lockfileCandidates) {
    // Left by an interrupted run, already in place
    if (existsSync(backup)) {
      lockfileBackups.push({ original, backup });
      continue;
    }
    try {
      renameSync(original, backup);
      lockfileBackups.push({ original, backup });
    } catch (error) {
      // ENOENT: no lockfile of this name in this directory.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  let nodeModulesMoved = false;
  if (existsSync(nodeModulesBackup)) {
    // Left by an interrupted run, already in place
    nodeModulesMoved = true;
  } else {
    try {
      renameSync(nodeModulesPath, nodeModulesBackup);
      nodeModulesMoved = true;
    } catch (error) {
      // ENOENT: no module tree to move.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  logger.info(`Installing updated dependencies in ${projectRoot}...`);
  try {
    execSync(getInstallCommand(packageManager), {
      stdio: 'inherit',
      cwd: projectAbsPath,
    });
  } catch (error) {
    if (previousPackageJson !== undefined) {
      writeFileSync(absolutePackageJsonPath, previousPackageJson);
    }
    rmSync(packageJsonBackupPath, { force: true });
    for (const { original, backup } of lockfileBackups) {
      renameSync(backup, original);
    }
    // A failed install can leave a partial module tree behind
    rmSync(nodeModulesPath, { recursive: true, force: true });
    if (nodeModulesMoved) {
      renameSync(nodeModulesBackup, nodeModulesPath);
    }
    throw error;
  }
  for (const { backup } of lockfileBackups) {
    rmSync(backup, { force: true });
  }
  rmSync(nodeModulesBackup, { recursive: true, force: true });
  rmSync(packageJsonBackupPath, { force: true });
}
