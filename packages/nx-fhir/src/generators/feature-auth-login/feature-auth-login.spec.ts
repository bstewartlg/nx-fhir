import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { featureAuthLoginGenerator } from './feature-auth-login';
import { authLoginFeature } from './auth-login';
import { FEATURES } from '../feature/registry';

const runFeature = vi.hoisted(() => vi.fn());
vi.mock('../feature/run-feature', () => ({ runFeature }));

describe('feature-auth-login generator', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('passes the project to runFeature', async () => {
    const tree = createTreeWithEmptyWorkspace();

    await featureAuthLoginGenerator(tree, { project: 'server' });

    expect(runFeature).toHaveBeenCalledWith(tree, {
      feature: 'auth-login',
      project: 'server',
      options: {},
    });
    expect(FEATURES).toContain(authLoginFeature);
  });

  it('passes the https options and drops an undefined value', async () => {
    const tree = createTreeWithEmptyWorkspace();

    await featureAuthLoginGenerator(tree, {
      project: 'server',
      viteHttps: false,
      composeHttps: undefined,
    });

    expect(runFeature).toHaveBeenCalledWith(tree, {
      feature: 'auth-login',
      project: 'server',
      options: { viteHttps: false },
    });
  });
});
