import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { featureAuthScopesGenerator } from './feature-auth-scopes';
import { authScopesFeature } from './auth-scopes';
import { FEATURES } from '../feature/registry';

const runFeature = vi.hoisted(() => vi.fn());
vi.mock('../feature/run-feature', () => ({ runFeature }));

describe('feature-auth-scopes generator', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('runs the auth-scopes feature of the feature registry', async () => {
    const tree = createTreeWithEmptyWorkspace();

    await featureAuthScopesGenerator(tree, { project: 'server' });

    expect(runFeature).toHaveBeenCalledWith(tree, {
      feature: 'auth-scopes',
      project: 'server',
      options: {},
    });
    expect(FEATURES).toContain(authScopesFeature);
  });
});
