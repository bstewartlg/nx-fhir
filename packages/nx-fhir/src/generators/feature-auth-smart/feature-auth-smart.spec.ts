import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { featureAuthSmartGenerator } from './feature-auth-smart';
import { authSmartFeature } from './auth-smart';
import { FEATURES } from '../feature/registry';

const runFeature = vi.hoisted(() => vi.fn());
vi.mock('../feature/run-feature', () => ({ runFeature }));

describe('feature-auth-smart generator', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('runs the auth-smart feature of the feature registry', async () => {
    const tree = createTreeWithEmptyWorkspace();

    await featureAuthSmartGenerator(tree, { project: 'server' });

    expect(runFeature).toHaveBeenCalledWith(tree, {
      feature: 'auth-smart',
      project: 'server',
      options: {},
    });
    expect(FEATURES).toContain(authSmartFeature);
  });
});
