import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, readProjectConfiguration } from '@nx/devkit';

import { presetGenerator } from './generator';
import { PresetGeneratorSchema } from './schema';
import { FhirVersion } from '../../shared/models';

describe('preset generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    process.argv.push('--dry-run'); // Ensure dry-run mode for tests
  });

  it('should run successfully without server', async () => {
    const options: PresetGeneratorSchema = {
      name: 'test',
      server: false,
      directory: 'fhir-app'
    };
    
    await presetGenerator(tree, options);
    
    // Check that workspace configuration exists
    expect(tree.exists('nx.json')).toBe(true);
  });

  it('should create server project when server option is true', async () => {
    const options: PresetGeneratorSchema = {
      name: 'test',
      server: true,
      directory: 'fhir-app',
      serverDirectory: 'server',
      packageBase: 'org.test.server',
      fhirVersion: FhirVersion.R4,
      release: '8.4.0'
    };
    
    await presetGenerator(tree, options);
    
    // The server generator creates a project with name based on the directory basename
    const config = readProjectConfiguration(tree, 'server');
    expect(config).toBeDefined();
    expect(config.root).toBe('server');
    expect(config.tags).toContain('nx-fhir-server');
  });
});
