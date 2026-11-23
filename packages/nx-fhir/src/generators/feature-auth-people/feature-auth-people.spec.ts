import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { featureAuthPeopleGenerator } from './feature-auth-people';
import { authPeopleFeature } from './auth-people';
import { FEATURES } from '../feature/registry';

const runFeature = vi.hoisted(() => vi.fn());
vi.mock('../feature/run-feature', () => ({ runFeature }));

describe('feature-auth-people generator', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('runs the auth-people feature of the feature registry', async () => {
    const tree = createTreeWithEmptyWorkspace();

    await featureAuthPeopleGenerator(tree, { project: 'server' });

    expect(runFeature).toHaveBeenCalledWith(tree, {
      feature: 'auth-people',
      project: 'server',
      options: {},
    });
    expect(FEATURES).toContain(authPeopleFeature);
  });
});
