import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';

import { featureAuthUdapGenerator } from './feature-auth-udap';
import { authUdapFeature } from './auth-udap';
import { FEATURES } from '../feature/registry';

const runFeature = vi.hoisted(() => vi.fn());
vi.mock('../feature/run-feature', () => ({ runFeature }));

describe('feature-auth-udap generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('forwards only defined options to runFeature', async () => {
    await featureAuthUdapGenerator(tree, {
      project: 'server',
      certFile: '/certs/server.pfx',
    });
    await featureAuthUdapGenerator(tree, {
      project: 'server',
      certFile: undefined,
    });

    expect(runFeature).toHaveBeenNthCalledWith(1, tree, {
      feature: 'auth-udap',
      project: 'server',
      options: { certFile: '/certs/server.pfx' },
    });
    expect(runFeature).toHaveBeenNthCalledWith(2, tree, {
      feature: 'auth-udap',
      project: 'server',
      options: {},
    });
  });

  it('is listed in the feature registry', () => {
    expect(FEATURES).toContain(authUdapFeature);
  });
});
