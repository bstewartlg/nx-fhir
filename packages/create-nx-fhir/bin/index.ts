#!/usr/bin/env node

import { createWorkspace } from 'create-nx-workspace';
import { input } from '@inquirer/prompts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

interface CliArgs {
  directory?: string;
  server?: boolean; // true => auto-generate, false => skip, undefined => prompt
  _?: (string | number)[];
}

const argv: CliArgs = yargs(hideBin(process.argv))
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
  .help()
  .alias('h', 'help')
  .parseSync();

function sanitizeDirectory(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function resolveDirectory(): Promise<string> {
  if (argv.directory) {
    return sanitizeDirectory(argv.directory);
  }
  // Accept first positional argument as directory if provided
  if (argv._ && argv._.length > 0 && typeof argv._[0] === 'string') {
    return sanitizeDirectory(argv._[0] as string);
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

async function main() {
  try {
    const name = await resolveDirectory();
    console.log(`Creating the workspace: ${name}`);

    // This assumes "nx-fhir" and "create-nx-fhir" are at the same version
    const presetVersion = require('../package.json').version;

    const { directory } = await createWorkspace(`nx-fhir@${presetVersion}`, {
      name,
      nxCloud: 'skip',
      packageManager: 'npm',
    });

    console.log(`Successfully created the workspace: ${directory}.`);
  } catch (e: any) {
    console.error(e?.message ?? e);
    process.exit(1);
  }
}

main();
