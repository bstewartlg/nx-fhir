import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, readProjectConfiguration } from '@nx/devkit';
import { featureGenerator } from './feature';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const select = vi.hoisted(() => vi.fn());
const input = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ select, input }));

const isInteractive = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

vi.mock('./registry', () => ({
  FEATURES: [
    {
      name: 'stub',
      description: 'stub feature',
      featureVersion: 1,
      minHapiVersion: '8.0.0',
      collectOptions: async (_t: unknown, _p: unknown, provided: object) => ({ ...provided }),
      apply: async () => undefined,
    },
  ],
}));

function createServerTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('test-project/src/main/java/.gitkeep', '');
  tree.write(
    'test-project/pom.xml',
    '<project><parent><groupId>ca.uhn.hapi.fhir</groupId><artifactId>hapi-fhir</artifactId><version>8.4.0</version></parent></project>'
  );
  addProjectConfiguration(tree, 'server', {
    root: 'test-project',
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  return tree;
}

function readFeatures(tree: Tree) {
  return (readProjectConfiguration(tree, 'server') as ServerProjectConfiguration).features;
}

describe('featureGenerator', () => {
  beforeEach(() => isInteractive.mockReturnValue(true));
  afterEach(() => vi.resetAllMocks());

  it('runs the named feature without prompting', async () => {
    const tree = createServerTree();
    await featureGenerator(tree, { project: 'server', feature: 'stub' });
    expect(readFeatures(tree)).toEqual({ stub: { version: 1, options: {} } });
    expect(select).not.toHaveBeenCalled();
  });

  it('forwards the options it does not own to the feature', async () => {
    const tree = createServerTree();
    await featureGenerator(tree, {
      project: 'server',
      feature: 'stub',
      intervalMs: 5000,
      storagePath: undefined,
    });
    expect(readFeatures(tree)).toEqual({
      stub: { version: 1, options: { intervalMs: 5000 } },
    });
  });

  it('prompts for the feature when it is omitted', async () => {
    const tree = createServerTree();
    select.mockResolvedValueOnce('stub');
    await featureGenerator(tree, { project: 'server' });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Select a feature to add:',
        choices: expect.arrayContaining([
          { name: 'stub', value: 'stub', description: 'stub feature' },
        ]),
      })
    );
    expect(readFeatures(tree)?.stub).toBeDefined();
  });

  it('throws naming the flag when the feature is omitted in a non-interactive run', async () => {
    const tree = createServerTree();
    isInteractive.mockReturnValue(false);
    await expect(featureGenerator(tree, { project: 'server' })).rejects.toThrow(
      'Missing required option --feature. Available features: stub'
    );
    expect(select).not.toHaveBeenCalled();
  });
});
