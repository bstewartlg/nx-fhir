import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, readProjectConfiguration } from '@nx/devkit';

import { frontendGenerator } from './frontend';
import { FrontendGeneratorSchema } from './schema';

describe('frontend generator', () => {
  let tree: Tree;
  const options: FrontendGeneratorSchema = { name: 'test' };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    process.argv.push('--dry-run'); // Ensure dry-run mode for tests
  });

  it('should run successfully', async () => {
    await frontendGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test');
    expect(config).toBeDefined();
  });
});
