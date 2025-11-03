import { addDependenciesToPackageJson, addProjectConfiguration, formatFiles, logger, ProjectConfiguration, readNxJson, removeDependenciesFromPackageJson, Tree, updateNxJson, updateProjectConfiguration } from '@nx/devkit';
import { PresetGeneratorSchema } from './schema';
import { serverGenerator } from '../server/server';
import { FhirVersion } from '../../shared/models';
import { ServerGeneratorSchema } from '../server/schema';
import { input, select } from '@inquirer/prompts';
import { registerNxPlugin } from '../../shared/utils';

export async function presetGenerator(
  tree: Tree,
  options: PresetGeneratorSchema
) {

  registerNxPlugin(tree);

  // Generate the server project if requested
  if (options.server) {
    // Only prompt for these options if server is true and they weren't provided
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
}

export default presetGenerator;
