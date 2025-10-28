import { execSync } from 'child_process';
import { logger } from '@nx/devkit';

/**
 * Check if the git repository has uncommitted changes
 * @returns true if the repository is clean, false otherwise
 */
export function isGitRepositoryClean(workspaceRoot: string): boolean {
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

    return status.trim().length === 0;
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
 */
export function ensureGitRepositoryClean(
  workspaceRoot: string,
  force = false
): void {
  if (force) {
    logger.warn('⚠️ Skipping git repository check due to --force flag');
    return;
  }

  if (!isGitRepositoryClean(workspaceRoot)) {
    throw new Error(
      'Git repository has uncommitted changes. ' +
      'Please commit or stash your changes before running this migration. ' +
      'You can skip this check with --force (not recommended).'
    );
  }

  logger.info('✅ Git repository is clean');
}

/**
 * Get the list of uncommitted files
 */
export function getUncommittedFiles(workspaceRoot: string): string[] {
  try {
    const status = execSync('git status --porcelain', {
      cwd: workspaceRoot,
      encoding: 'utf-8',
    });

    return status
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => line.substring(3)); // Remove status prefix
  } catch (error) {
    return [];
  }
}
