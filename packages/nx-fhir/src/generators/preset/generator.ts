import {
  addProjectConfiguration,
  formatFiles,
  Tree,
} from '@nx/devkit';
import { PresetGeneratorSchema } from './schema';
import { serverGenerator } from '../server/server';

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
  // if (options.server) {
  //   await serverGenerator(tree, {
  //     directory: 'server',
  //     packageBase: 'org.custom.server',
  //     fhirVersion: 'R4',
  //   } as any);
  // }
}

export default presetGenerator;
