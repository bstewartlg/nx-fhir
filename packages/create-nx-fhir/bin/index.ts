#!/usr/bin/env node

import { createWorkspace } from 'create-nx-workspace';
import { input } from '@inquirer/prompts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { logger } from '@nx/devkit';
import { execSync } from 'child_process';

export const SUPPORTED_PACKAGE_MANAGERS = ['bun', 'npm'] as const;

export type PackageManager = typeof SUPPORTED_PACKAGE_MANAGERS[number];

export interface CliArgs {
  directory?: string;
  server?: boolean; // true => auto-generate, false => skip, undefined => prompt
  packageManager?: PackageManager;
  serverDirectory?: string;
  packageBase?: string;
  release?: string;
  fhirVersion?: 'STU3' | 'R4' | 'R4B' | 'R5';
  verbose?: boolean;
  _?: (string | number)[];
}

export function parseArgs(argv: string[]): CliArgs {
  return yargs(hideBin(argv))
    .scriptName('create-nx-fhir')
    .usage('$0 [name] [options]')
    .option('directory', {
      type: 'string',
      description: 'Directory name',
    })
    .option('server', {
      type: 'boolean',
      description:
        'Whether to generate a FHIR server (true = generate, false = skip). If omitted you will be prompted.',
    })
    .option('packageManager', {
      type: 'string',
      description: 'Package manager to use',
      choices: ['bun', 'npm'],
      default: 'bun'
    })
    .option('serverDirectory', {
      type: 'string',
      description: 'The directory to create the server in'
    })
    .option('packageBase', {
      type: 'string',
      description: 'The Java package path for custom code'
    })
    .option('release', {
      type: 'string',
      description: 'The HAPI FHIR JPA Starter release to use'
    })
    .option('fhirVersion', {
      type: 'string',
      description: 'The FHIR version to use for the server',
      choices: ['STU3', 'R4', 'R4B', 'R5']
    })
    .option('verbose', {
      type: 'boolean',
      description: 'Enable verbose logging'
    })
    .help()
    .alias('h', 'help')
    .parseSync() as CliArgs;
}

const argv: CliArgs = parseArgs(process.argv);

export function sanitizeDirectory(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function resolveDirectory(args: CliArgs): Promise<string> {
  if (args.directory) {
    return sanitizeDirectory(args.directory);
  }
  // Accept first positional argument as directory if provided
  if (args._ && args._.length > 0 && typeof args._[0] === 'string') {
    return sanitizeDirectory(args._[0] as string);
  }
  return await input({
    message: 'Workspace directory:',
    validate: (val) => {
      const cleaned = sanitizeDirectory(val);
      if (!cleaned)
        return 'Please enter a valid directory (alphanumeric and dashes).';
      if (!/^[a-z][a-z0-9-]*$/.test(cleaned))
        return 'Directory must start with a letter and contain only lowercase letters, numbers and dashes.';
      return true;
    },
  }).then(sanitizeDirectory);
}

export function isPackageManagerAvailable(pm: PackageManager): boolean {

  // Ensure it's a supported package manager
  if (SUPPORTED_PACKAGE_MANAGERS.indexOf(pm) === -1) {
    return false;
  }

  try {
    logger.info(`Checking availability of package manager: ${pm} --version`);
    execSync(`${pm} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function resolvePackageManager(requested?: PackageManager): PackageManager {
  if (!requested) {
    requested = 'bun';
  }

  if (isPackageManagerAvailable(requested)) {
    return requested;
  }

  logger.warn(`Package manager '${requested}' is not available. Falling back to 'npm'.`);
  
  if (!isPackageManagerAvailable('npm')) {
    logger.error('npm is not available. Please install npm to continue.');
    process.exit(1);
  }

  return 'npm';
}

async function main() {
  try {
    const name = await resolveDirectory(argv);
    logger.info(`Creating the workspace: ${name}`);

    // This assumes "nx-fhir" and "create-nx-fhir" are at the same version
    const presetVersion = require('../package.json').version;

    const packageManager = resolvePackageManager(argv.packageManager);

    logger.info(`Using package manager: ${packageManager}`);

    // Extract only the preset-specific options
    const { server, serverDirectory, packageBase, release, fhirVersion } = argv;
    const presetOptions: Record<string, any> = { server };
    if (serverDirectory !== undefined) presetOptions.serverDirectory = serverDirectory;
    if (packageBase !== undefined) presetOptions.packageBase = packageBase;
    if (release !== undefined) presetOptions.release = release;
    if (fhirVersion !== undefined) presetOptions.fhirVersion = fhirVersion;

    const { directory } = await createWorkspace(`nx-fhir@${presetVersion}`, {
      name,
      nxCloud: 'skip',
      packageManager,
      ...presetOptions
    });

    logger.info(`Successfully created the workspace here: ${directory}.`);
  } catch (e: any) {
    logger.error(e?.message ?? e);
    process.exit(1);
  }
}

// Only run main if not in test environment
if (process.env.NODE_ENV !== 'test') {
  main();
}
