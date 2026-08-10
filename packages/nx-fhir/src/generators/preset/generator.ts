import { formatFiles, logger, Tree } from '@nx/devkit';
import { PresetGeneratorSchema } from './schema';
import { serverGenerator } from '../server/server';
import { FhirVersion } from '../../shared/models';
import { ServerGeneratorSchema } from '../server/schema';
import { confirm, input, select } from '@inquirer/prompts';
import { registerNxPlugin } from '../../shared/utils';
import { detectExistingServer } from '../../shared/utils/server-detection';
import { importServerGenerator } from '../import-server/import-server';

export async function presetGenerator(
  tree: Tree,
  options: PresetGeneratorSchema
) {

  registerNxPlugin(tree);

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
  const shouldGenerate =
    options.server ??
    (await confirm({
      message: 'Generate a FHIR server project?',
      default: true,
    }));

  if (!shouldGenerate) {
    return;
  }

  // Only prompt for these options if they weren't provided
  if (!options.serverDirectory) {
    options.serverDirectory = await input({
      message: 'Enter the directory for the new server source code',
      default: 'server',
    });
  }

  if (!options.packageBase) {
    options.packageBase = await input({
      message: 'Enter the Java package path for your custom code',
      default: 'org.custom.server',
    });
  }

  if (!options.fhirVersion) {
    options.fhirVersion = (await select({
      message: 'Select the FHIR version to use for the server',
      choices: [
        { name: 'STU3', value: 'STU3' },
        { name: 'R4', value: 'R4' },
        { name: 'R4B', value: 'R4B' },
        { name: 'R5', value: 'R5' },
      ],
      default: 'R4',
    })) as FhirVersion;
  }

  // generate server project
  await serverGenerator(tree, {
    directory: options.serverDirectory,
    packageBase: options.packageBase,
    fhirVersion: options.fhirVersion,
    release: options.release,
  } as ServerGeneratorSchema);

  await formatFiles(tree);
}

export default presetGenerator;
