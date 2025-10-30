import { detectPackageManager, PackageManager } from '@nx/devkit';
import { execSync } from 'child_process';


export function getPackageManager(): PackageManager {
  const envPm = process.env.PACKAGE_MANAGER;
  if (envPm) {
    const value = envPm.toLowerCase();
    if (value === 'npm' || value === 'bun') {
      return value as PackageManager;
    }
  }
  
  // Fallback to auto-detection or bun if detection fails
  return detectPackageManager() || 'bun';
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

  let baseCommand = '';
  switch (packageManager) {
    case 'bun':
      baseCommand = 'bun install';
      break;
    case 'npm':
      baseCommand = 'npm install';
      break;
  }
  
  if (!packageName) {
    return baseCommand;
  }
  return `${baseCommand} ${devFlag} ${packageName}`;
}

/**
 * Gets the list command for the specified package manager
 */
export function getListCommand(
  packageManager: PackageManager,
  packageName: string
): string {
  switch (packageManager) {
    case 'bun':
      return process.platform === 'win32'
        ? `bun pm ls | findstr ${packageName}`
        : `bun pm ls | grep ${packageName}`;
    case 'npm':
      return `npm ls ${packageName}`;
  }
}

/**
 * Gets the run command for the specified package manager
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
  }
}

/**
 * Gets the execute command for the specified package manager (npx/bunx equivalent)
 */
export function getExecuteCommand(
  packageManager: PackageManager,
  command?: string
): string {
  switch (packageManager) {
    case 'bun':
      return `bunx ${command ?? ''}`.trim();
    case 'npm':
      return `npx ${command ?? ''}`.trim();
  }
}

export function getPackCommand(
  packageManager: PackageManager
): string {
  switch (packageManager) {
    case 'bun':
      return `bun pm pack`;
    case 'npm':
      return `npm pack`;
  }
}
