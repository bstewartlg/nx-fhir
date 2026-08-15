#!/usr/bin/env node

import { createWorkspace } from 'create-nx-workspace';
import { input } from '@inquirer/prompts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { logger } from '@nx/devkit';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const SUPPORTED_PACKAGE_MANAGERS = ['bun', 'npm'] as const;

export type PackageManager = (typeof SUPPORTED_PACKAGE_MANAGERS)[number];

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
      default: 'bun',
    })
    .option('serverDirectory', {
      type: 'string',
      description: 'The directory to create the server in',
    })
    .option('packageBase', {
      type: 'string',
      description: 'The Java package path for custom code',
    })
    .option('release', {
      type: 'string',
      description: 'The HAPI FHIR JPA Starter release to use',
    })
    .option('fhirVersion', {
      type: 'string',
      description: 'The FHIR version to use for the server',
      choices: ['STU3', 'R4', 'R4B', 'R5'],
    })
    .option('verbose', {
      type: 'boolean',
      description: 'Enable verbose logging',
    })
    .version(require('../package.json').version)
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

export const CURRENT_DIR_SENTINEL = '.';

export async function resolveDirectory(args: CliArgs): Promise<string> {
  // Detect "." before sanitization since sanitizeDirectory strips it
  const rawDir =
    args.directory ??
    (args._ && args._.length > 0 && typeof args._[0] === 'string'
      ? (args._[0] as string)
      : undefined);
  if (rawDir?.trim() === '.') {
    return CURRENT_DIR_SENTINEL;
  }

  if (args.directory) {
    return sanitizeDirectory(args.directory);
  }
  if (rawDir) {
    return sanitizeDirectory(rawDir);
  }
  return await input({
    message: 'Workspace directory (enter "." to use the current directory):',
    validate: (val) => {
      if (val.trim() === '.') return true;
      const cleaned = sanitizeDirectory(val);
      if (!cleaned)
        return 'Please enter a valid directory (alphanumeric and dashes).';
      if (!/^[a-z][a-z0-9-]*$/.test(cleaned))
        return 'Directory must start with a letter and contain only lowercase letters, numbers and dashes.';
      return true;
    },
  }).then((val) =>
    val.trim() === '.' ? CURRENT_DIR_SENTINEL : sanitizeDirectory(val),
  );
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

export function resolvePackageManager(
  requested?: PackageManager,
): PackageManager {
  if (!requested) {
    requested = 'bun';
  }

  if (isPackageManagerAvailable(requested)) {
    return requested;
  }

  logger.warn(
    `Package manager '${requested}' is not available. Falling back to 'npm'.`,
  );

  if (!isPackageManagerAvailable('npm')) {
    logger.error('npm is not available. Please install npm to continue.');
    process.exit(1);
  }

  return 'npm';
}

function buildInstallCommand(pm: PackageManager, packages: string[]): string {
  const pkgList = packages.join(' ');
  if (pm === 'bun') {
    return `bun add --dev ${pkgList}`;
  }
  return `npm install --save-dev ${pkgList}`;
}

export interface PresetOptions {
  server?: boolean;
  serverDirectory?: string;
  packageBase?: string;
  release?: string;
  fhirVersion?: string;
}

/**
 * Records an analytics preference in nx.json when the workspace has not made
 * one. The nx CLI prompts for usage data at startup, before it runs the
 * generator, whenever nx.json exists without a boolean analytics field.
 */
export function stageAnalyticsPreference(directory: string): void {
  const nxJsonPath = path.join(directory, 'nx.json');
  if (!fs.existsSync(nxJsonPath)) {
    return;
  }

  const nxJson = JSON.parse(fs.readFileSync(nxJsonPath, 'utf-8'));
  if (typeof nxJson.analytics === 'boolean') {
    return;
  }

  fs.writeFileSync(
    nxJsonPath,
    JSON.stringify({ ...nxJson, analytics: false }, null, 2) + '\n',
  );
}

export async function initExistingDirectory(
  packageManager: PackageManager,
  presetVersion: string,
  presetOptions: PresetOptions,
): Promise<void> {
  const cwd = process.cwd();
  const name = path.basename(cwd);

  // Ensure package.json exists
  const pkgJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    logger.info('Creating package.json...');
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name, version: '0.0.0', private: true }, null, 2) + '\n',
    );
  }

  // Ensure nx.json exists
  const nxJsonPath = path.join(cwd, 'nx.json');
  if (!fs.existsSync(nxJsonPath)) {
    logger.info('Creating nx.json...');
    fs.writeFileSync(
      nxJsonPath,
      JSON.stringify(
        { $schema: './node_modules/nx/schemas/nx-schema.json', plugins: [] },
        null,
        2,
      ) + '\n',
    );
  }

  // Install dependencies
  const installCmd = buildInstallCommand(packageManager, [
    'nx',
    '@nx/devkit',
    `nx-fhir@${presetVersion}`,
  ]);
  logger.info(`Installing dependencies: ${installCmd}`);
  execSync(installCmd, { stdio: 'inherit', cwd });

  // Build preset generator CLI flags
  const flagParts: string[] = [];
  if (presetOptions.server !== undefined)
    flagParts.push(`--server=${presetOptions.server}`);
  if (presetOptions.serverDirectory)
    flagParts.push(`--serverDirectory=${presetOptions.serverDirectory}`);
  if (presetOptions.packageBase)
    flagParts.push(`--packageBase=${presetOptions.packageBase}`);
  if (presetOptions.release)
    flagParts.push(`--release=${presetOptions.release}`);
  if (presetOptions.fhirVersion)
    flagParts.push(`--fhirVersion=${presetOptions.fhirVersion}`);

  stageAnalyticsPreference(cwd);

  const generatorCmd = `npx nx g nx-fhir:preset ${flagParts.join(' ')}`.trim();
  logger.info(`Running preset generator: ${generatorCmd}`);
  execSync(generatorCmd, { stdio: 'inherit', cwd });
}

async function main() {
  try {
    const directory = await resolveDirectory(argv);

    // This assumes "nx-fhir" and "create-nx-fhir" are at the same version
    const presetVersion = require('../package.json').version;

    const packageManager = resolvePackageManager(argv.packageManager);

    logger.info(`Using package manager: ${packageManager}`);

    // Extract only the preset-specific options
    const { server, serverDirectory, packageBase, release, fhirVersion } = argv;
    const presetOptions: PresetOptions = { server };
    if (serverDirectory !== undefined)
      presetOptions.serverDirectory = serverDirectory;
    if (packageBase !== undefined) presetOptions.packageBase = packageBase;
    if (release !== undefined) presetOptions.release = release;
    if (fhirVersion !== undefined) presetOptions.fhirVersion = fhirVersion;

    if (directory === CURRENT_DIR_SENTINEL) {
      logger.info('Initializing nx-fhir in the current directory...');
      await initExistingDirectory(packageManager, presetVersion, presetOptions);
      logger.info('Successfully initialized nx-fhir in the current directory.');
    } else {
      logger.info(`Creating the workspace: ${directory}`);
      const { directory: createdDir } = await createWorkspace(
        `nx-fhir@${presetVersion}`,
        {
          name: directory,
          nxCloud: 'skip',
          packageManager,
          // nx new records this in nx.json, so the preset generator it spawns
          // next starts inside a workspace that has already answered the
          // analytics prompt.
          analytics: false,
          // The user already chose nx-fhir by running this CLI, so skip the
          // third-party preset trust prompt. The prompt defaults to "No" and
          // blocks forever in wrappers that keep stdin open without input.
          interactive: false,
          ...presetOptions,
        },
      );
      logger.info(`Successfully created the workspace here: ${createdDir}.`);
    }
  } catch (e) {
    const message =
      e && typeof e === 'object' && 'message' in e ? (e.message ?? e) : e;
    logger.error(message);
    process.exit(1);
  }
}

// Only run main if not in test environment
if (process.env.NODE_ENV !== 'test') {
  main();
}
