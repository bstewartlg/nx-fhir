import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, getProjects, readProjectConfiguration } from '@nx/devkit';

import { operationGenerator } from './operation';
import { OperationGeneratorSchema } from './schema';
import { ServerProjectConfiguration } from '../../shared/models';

describe('operation generator', () => {
  let tree: Tree;
  const options: OperationGeneratorSchema = { 
    name: 'test', 
    project: 'test',
    defContent: `{
      "resourceType": "OperationDefinition",
      "name": "TestOperation",
      "code": "test-operation",
    }`,
    directory: 'com/example/providers'
  };

  beforeAll(() => {
    tree = createTreeWithEmptyWorkspace();
    tree.write('test-project/src/main/java/', '');
    addProjectConfiguration(tree, 'test', {
      root: 'test-project',
      projectType: 'application',
      packageBase: 'com.example',
      fhirVersion: 'R4'
    } as ServerProjectConfiguration);
  });

  it('should generate an operation', async () => {
    await operationGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test');
    expect(config).toBeDefined();
    expect(tree.exists('test-project/src/main/java/com/example/providers/TestOperation.java')).toBeTruthy();
  });
});
