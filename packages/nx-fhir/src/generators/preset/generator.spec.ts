import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, readProjectConfiguration } from '@nx/devkit';

import { presetGenerator } from './generator';
import { PresetGeneratorSchema } from './schema';
import { FhirVersion } from '../../shared/models';

describe('preset generator', () => {
  let tree: Tree;
  const options: PresetGeneratorSchema = {
    name: 'test',
    server: false
  };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('should run successfully', async () => {
    await presetGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test');
    expect(config).toBeDefined();
  });
});
