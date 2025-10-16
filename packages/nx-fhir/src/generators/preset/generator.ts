import {
  addProjectConfiguration,
  formatFiles,
  Tree,
} from '@nx/devkit';
import { PresetGeneratorSchema } from './schema';
import { serverGenerator } from '../server/server';
import { FhirVersion } from '../../shared/models';
import { ServerGeneratorSchema } from '../server/schema';
import { confirm, input, select } from '@inquirer/prompts';

export async function presetGenerator(
  tree: Tree,
  options: PresetGeneratorSchema
) {
  const projectRoot = ``;
  addProjectConfiguration(tree, options.name, {
    root: projectRoot,
    projectType: 'application',
    sourceRoot: `${projectRoot}/src`,
    targets: {},
  });

  await formatFiles(tree);

  // Generate the server project if requested
  console.log('Server option:', options.server);
  if (options.server) {
    console.log('options.directory:', options.directory, !options.directory);
    console.log('options.packageBase:', options.packageBase);
    console.log('options.fhirVersion:', options.fhirVersion);
    // Only prompt for these options if server is true and they weren't provided
    if (!options.directory) {
      options.directory = await input({
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
      options.fhirVersion = await select({
        message: 'Select the FHIR version to use for the server',
        choices: [
          { name: 'STU3', value: 'STU3' },
          { name: 'R4', value: 'R4' },
          { name: 'R4B', value: 'R4B' },
          { name: 'R5', value: 'R5' },
        ],
        default: 'R4',
      }) as FhirVersion;
    }

    await serverGenerator(tree, {
      ...options
    } as ServerGeneratorSchema);
  }
}

export default presetGenerator;
