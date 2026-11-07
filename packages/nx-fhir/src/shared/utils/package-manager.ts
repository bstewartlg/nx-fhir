import {
  detectPackageManager,
  getPackageManagerCommand,
  PackageManager,
  workspaceRoot,
} from '@nx/devkit';


export function getPackageManager(): PackageManager {
  const envPm = process.env.PACKAGE_MANAGER;
  if (envPm) {
    const value = envPm.toLowerCase();
    if (value === 'npm' || value === 'bun') {
      return value as PackageManager;
    }
  }

  // Fallback to auto-detection from the workspace root lockfile, or bun if detection fails
  return detectPackageManager(workspaceRoot) || 'bun';
}


/**
 * The plugin supports bun and npm only. Devkit builds commands for every package manager,
 * so the check runs before the call.
 */
function getSupportedCommands(packageManager: PackageManager) {
  if (packageManager !== 'bun' && packageManager !== 'npm') {
    throw new Error(`Unsupported package manager: ${packageManager}`);
  }
  return getPackageManagerCommand(packageManager);
}

/**
 * Gets the install command for the specified package manager
 */
export function getInstallCommand(
  packageManager: PackageManager,
  packageName?: string,
  isDev?: boolean
): string {
  const devFlag = isDev ? '-D' : '';
  const baseCommand = getSupportedCommands(packageManager).install;

  if (!packageName) {
    return baseCommand;
  }
  return `${baseCommand} ${devFlag} ${packageName}`;
}

/**
 * Gets the run command for the specified package manager.
 * Devkit's bun form renders `bun run <script> -- ` with a trailing ` -- ` when there are
 * no arguments, and generated Dockerfiles carry the returned command verbatim.
 */
export function getRunCommand(
  packageManager: PackageManager,
  script: string
): string {
  switch (packageManager) {
    case 'bun':
      return `bun run ${script}`;
    case 'npm':
      return `npm run ${script}`;
    default:
      throw new Error(`Unsupported package manager: ${packageManager}`);
  }
}

/**
 * Gets the execute command for the specified package manager (npx/bunx equivalent)
 */
export function getExecuteCommand(
  packageManager: PackageManager,
  command?: string
): string {
  return `${getSupportedCommands(packageManager).dlx} ${command ?? ''}`.trim();
}

/**
 * Gets the CI install command for the specified package manager (frozen lockfile).
 * Devkit's bun `ciInstall` is `bun install --no-cache`, and the Docker build runs
 * `bun install --frozen-lockfile`.
 */
export function getCiInstallCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'bun install --frozen-lockfile';
    case 'npm':
      return 'npm ci';
    default:
      throw new Error(`Unsupported package manager: ${packageManager}`);
  }
}

/**
 * Gets the Docker base image for the specified package manager
 */
export function getDockerBaseImage(packageManager: PackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'oven/bun:1-slim';
    case 'npm':
      return 'node:24-slim';
    default:
      throw new Error(`Unsupported package manager: ${packageManager}`);
  }
}

/**
 * Gets the lockfile name for the specified package manager.
 * Devkit's lockfile name helper lives under `nx/src/plugins/js`, a deep import.
 */
export function getLockfileName(packageManager: PackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'bun.lock';
    case 'npm':
      return 'package-lock.json';
    default:
      throw new Error(`Unsupported package manager: ${packageManager}`);
  }
}
