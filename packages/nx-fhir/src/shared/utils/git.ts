import { execSync } from 'child_process';
import { logger } from '@nx/devkit';

/**
 * Files that are expected to be modified during `nx migrate` process.
 * These are safe to ignore when checking for uncommitted changes.
 */
const NX_MIGRATE_EXPECTED_FILES = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'migrations.json',
];

/**
 * Check if a file is an expected modification from `nx migrate`
 */
function isNxMigrateFile(filePath: string): boolean {
  return NX_MIGRATE_EXPECTED_FILES.some(
    expected => filePath === expected || filePath.endsWith(`/${expected}`)
  );
}

/**
 * Check if the git repository has uncommitted changes
 * @param excludeNxMigrateFiles - If true, ignore files typically modified by nx migrate
 * @returns true if the repository is clean, false otherwise
 */
export function isGitRepositoryClean(
  workspaceRoot: string,
  excludeNxMigrateFiles = false
): boolean {
  try {
    // Check if git is initialized
    execSync('git rev-parse --git-dir', {
      cwd: workspaceRoot,
      stdio: 'pipe',
    });

    // Check for uncommitted changes
    const status = execSync('git status --porcelain', {
      cwd: workspaceRoot,
      encoding: 'utf-8',
    });

    if (status.trim().length === 0) {
      return true;
    }

    if (excludeNxMigrateFiles) {
      // Filter out expected nx migrate files
      const unexpectedChanges = status
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => line.substring(3)) // Remove status prefix
        .filter(file => !isNxMigrateFile(file));

      return unexpectedChanges.length === 0;
    }

    return false;
  } catch (error) {
    // Not a git repository or git not available
    logger.warn('Unable to check git status. Git may not be initialized or available.');
    return false;
  }
}

/**
 * Check if git repository is clean and throw if not
 * @param workspaceRoot - The root of the workspace
 * @param force - Skip the check if true
 * @param excludeNxMigrateFiles - If true, ignore files typically modified by nx migrate
 */
export function ensureGitRepositoryClean(
  workspaceRoot: string,
  force = false,
  excludeNxMigrateFiles = false
): void {
  if (force) {
    logger.warn('⚠️ Skipping git repository check due to --force flag');
    return;
  }

  if (!isGitRepositoryClean(workspaceRoot, excludeNxMigrateFiles)) {
    const filesDescription = excludeNxMigrateFiles
      ? 'Git repository has uncommitted changes (excluding nx migrate files). '
      : 'Git repository has uncommitted changes. ';

    throw new Error(
      filesDescription +
      'Please commit or stash your changes before running this migration. ' +
      'You can skip this check with --force (not recommended).'
    );
  }

  if (excludeNxMigrateFiles) {
    logger.info('✅ Git repository is clean (excluding nx migrate files)');
  } else {
    logger.info('✅ Git repository is clean');
  }
}

/**
 * Get the list of uncommitted files
 * @param excludeNxMigrateFiles - If true, filter out files typically modified by nx migrate
 */
export function getUncommittedFiles(
  workspaceRoot: string,
  excludeNxMigrateFiles = false
): string[] {
  try {
    const status = execSync('git status --porcelain', {
      cwd: workspaceRoot,
      encoding: 'utf-8',
    });

    let files = status
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => line.substring(3)); // Remove status prefix

    if (excludeNxMigrateFiles) {
      files = files.filter(file => !isNxMigrateFile(file));
    }

    return files;
  } catch (error) {
    return [];
  }
}
