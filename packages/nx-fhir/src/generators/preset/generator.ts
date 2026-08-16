import { logger, Tree, updateJson } from '@nx/devkit';
import { PresetGeneratorSchema } from './schema';
import { serverGenerator } from '../server/server';
import { FhirVersion } from '../../shared/models';
import { ServerGeneratorSchema } from '../server/schema';
import { confirm, input, select } from '@inquirer/prompts';
import { ensureGitignoreEntries, registerNxPlugin } from '../../shared/utils';
import { detectExistingServer } from '../../shared/utils/server-detection';
import { isInteractive } from '../../shared/utils/interactive';
import { importServerGenerator } from '../import-server/import-server';

const DEFAULT_SERVER_DIRECTORY = 'server';
const DEFAULT_PACKAGE_BASE = 'org.custom.server';

const GITIGNORE_ENTRIES = ['node_modules', '.nx/cache', '.nx/workspace-data'];

export async function presetGenerator(
  tree: Tree,
  options: PresetGeneratorSchema,
) {
  registerNxPlugin(tree);

  // A workspace made by create-nx-workspace already ignores the Nx artifacts, but
  // initializing in an existing directory (for example an imported HAPI server) does not.
  ensureGitignoreEntries(tree, '.gitignore', GITIGNORE_ENTRIES);

  // A boolean analytics field in nx.json suppresses the Nx usage-data prompt.
  updateJson(tree, 'nx.json', (json) => ({
    ...json,
    analytics: json.analytics ?? false,
  }));

  // Detect an existing HAPI server (workspace root first, then a provided serverDirectory)
  // BEFORE deciding whether to scaffold or asking the user to generate one. An already-present
  // server is imported rather than prompting to create a new one over the top of it.
  const detected =
    detectExistingServer(tree, '.') ??
    (options.serverDirectory
      ? detectExistingServer(tree, options.serverDirectory)
      : null);

  if (detected && options.server !== false) {
    logger.info(
      `Detected an existing HAPI FHIR server at "${detected.root}"; importing it instead of generating a new one.`,
    );
    await importServerGenerator(tree, {
      directory: detected.root,
      name: options.name,
      packageBase: options.packageBase,
      fhirVersion: options.fhirVersion,
      release: options.release,
    });
    return;
  }

  // No existing server to import. Honor an explicit choice, otherwise ask.
  // Without a terminal the prompts never resolve, so take the same answer the
  // prompt offers as its default.
  const interactive = isInteractive();

  const shouldGenerate =
    options.server ??
    (interactive
      ? await confirm({
          message: 'Generate a FHIR server project?',
          default: true,
        })
      : true);

  if (!shouldGenerate) {
    return;
  }

  // Only prompt for these options if they weren't provided
  if (!options.serverDirectory) {
    options.serverDirectory = interactive
      ? await input({
          message: 'Enter the directory for the new server source code',
          default: DEFAULT_SERVER_DIRECTORY,
        })
      : DEFAULT_SERVER_DIRECTORY;
  }

  if (!options.packageBase) {
    options.packageBase = interactive
      ? await input({
          message: 'Enter the Java package path for your custom code',
          default: DEFAULT_PACKAGE_BASE,
        })
      : DEFAULT_PACKAGE_BASE;
  }

  if (!options.fhirVersion) {
    options.fhirVersion = interactive
      ? ((await select({
          message: 'Select the FHIR version to use for the server',
          choices: [
            { name: 'STU3', value: 'STU3' },
            { name: 'R4', value: 'R4' },
            { name: 'R4B', value: 'R4B' },
            { name: 'R5', value: 'R5' },
          ],
          default: 'R4',
        })) as FhirVersion)
      : FhirVersion.R4;
  }

  // generate server project
  await serverGenerator(tree, {
    directory: options.serverDirectory,
    packageBase: options.packageBase,
    fhirVersion: options.fhirVersion,
    release: options.release,
  } as ServerGeneratorSchema);

  // No formatFiles here: the tree holds the vendored HAPI starter files the
  // server generator just wrote, and server migrations merge against the
  // unformatted upstream release.
}

export default presetGenerator;
