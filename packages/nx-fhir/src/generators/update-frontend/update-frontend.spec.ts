import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, readProjectConfiguration } from '@nx/devkit';

import { UpdateFrontendGeneratorSchema } from './schema';
import { FrontendProjectConfiguration } from '../../shared/models';
import { PLUGIN_VERSION } from '../../shared/constants/versions';

describe('update-frontend generator', () => {
  let tree: Tree;

  beforeAll(() => {
    tree = createTreeWithEmptyWorkspace();
    const frontendProjectConfig: FrontendProjectConfiguration = {
      root: 'my-frontend',
      projectType: 'application',
      sourceRoot: 'my-frontend/src',
      tags: ['nx-fhir-frontend', 'fhir', 'frontend', 'client'],
      frontendVersion: '0.2.0',
      frontendTemplate: 'browser',
      pluginVersion: PLUGIN_VERSION
    }
    addProjectConfiguration(tree, 'my-frontend', frontendProjectConfig);
  });

  it('should have a valid project configuration', () => {
    const config = readProjectConfiguration(tree, 'my-frontend') as FrontendProjectConfiguration;
    expect(config).toBeDefined();
    expect(config.frontendVersion).toBe('0.2.0');
    expect(config.frontendTemplate).toBe('browser');
    expect(config.tags).toContain('nx-fhir-frontend');
  });

  it('should detect frontend projects by tag', () => {
    const config = readProjectConfiguration(tree, 'my-frontend');
    expect(config.tags).toContain('nx-fhir-frontend');
  });
});
