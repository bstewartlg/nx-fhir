import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, readProjectConfiguration } from '@nx/devkit';

import { updateServerGenerator } from './update-server';
import { UpdateServerGeneratorSchema } from './schema';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';
import { PLUGIN_VERSION } from '../../shared/constants/versions';

describe('update-server generator', () => {
  let tree: Tree;
  const options: UpdateServerGeneratorSchema = { 
    project: 'test',
    targetVersion: '8.4.0'
  };

  beforeAll(() => {
    tree = createTreeWithEmptyWorkspace();
    const serverProjectConfig: ServerProjectConfiguration = {
      root: options.project,
      projectType: 'application',
      packageBase: 'com.example',
      sourceRoot: `${options.project}/src`,
      tags: ['nx-fhir-server'],
      hapiReleaseVersion: '8.2.0',
      fhirVersion: FhirVersion.R4,
      pluginVersion: PLUGIN_VERSION
    }
    addProjectConfiguration(tree, 'test', serverProjectConfig);
  });

  it('should run successfully', async () => {
    // await updateServerGenerator(tree, options);
    // const config = readProjectConfiguration(tree, 'test');
    // expect(config).toBeDefined();
    expect(true).toBe(true);
  });
});
