import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';

import { featureAuthResourceGenerator } from './feature-auth-resource';
import { authResourceFeature } from './auth-resource';
import { FEATURES } from '../feature/registry';

const runFeature = vi.hoisted(() => vi.fn());
vi.mock('../feature/run-feature', () => ({ runFeature }));

describe('feature-auth-resource generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('forwards only defined options to runFeature', async () => {
    await featureAuthResourceGenerator(tree, {
      project: 'server',
      issuer: 'https://issuer.example.org',
      audience: 'https://fhir.example.org/fhir',
    });
    await featureAuthResourceGenerator(tree, {
      project: 'server',
      issuer: 'https://issuer.example.org',
      audience: undefined,
    });

    expect(runFeature).toHaveBeenNthCalledWith(1, tree, {
      feature: 'auth-resource',
      project: 'server',
      options: {
        issuer: 'https://issuer.example.org',
        audience: 'https://fhir.example.org/fhir',
      },
    });
    expect(runFeature).toHaveBeenNthCalledWith(2, tree, {
      feature: 'auth-resource',
      project: 'server',
      options: { issuer: 'https://issuer.example.org' },
    });
  });

  it('is listed in the feature registry', () => {
    expect(FEATURES).toContain(authResourceFeature);
  });
});
