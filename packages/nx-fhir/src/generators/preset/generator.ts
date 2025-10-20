import { addDependenciesToPackageJson, addProjectConfiguration, formatFiles, ProjectConfiguration, removeDependenciesFromPackageJson, Tree, updateProjectConfiguration } from '@nx/devkit';
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
  // const projectConfig: ProjectConfiguration = {
  //   root: projectRoot,
  //   projectType: 'application',
  //   targets: {
  //     start: {
  //       executor: 'nx:run-commands',
  //       options: {
  //         commands: [],
  //         parallel: true,
  //       },
  //     },
  //     build: {
  //       executor: 'nx:run-commands',
  //       options: {
  //         commands: [],
  //         parallel: false,
  //       },
  //     },
  //   },
  // };
  // addProjectConfiguration(tree, options.name, projectConfig);
  // removeDependenciesFromPackageJson(tree, ["nx-fhir"], []);
  // addDependenciesToPackageJson(tree, {}, { "nx-fhir": require('../../../package.json').version });

  await formatFiles(tree);

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


    // update the start and build commands to include server commands
    // projectConfig.targets.start.options.commands.push(`nx start ${options.serverDirectory}`);
    // projectConfig.targets.build.options.commands.push(`cd ${options.serverDirectory} && mvn clean package`);
    // updateProjectConfiguration(tree, options.name, projectConfig);
  }
}

export default presetGenerator;
