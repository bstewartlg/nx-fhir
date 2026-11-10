import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  readProjectConfiguration,
} from '@nx/devkit';
import { readFileSync } from 'fs';
import { join } from 'path';

import { featureFrontendProxyGenerator } from './feature-frontend-proxy';
import { frontendProxyFeature } from './frontend-proxy';
import { FEATURES } from '../feature/registry';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const runFeature = vi.hoisted(() => vi.fn());
vi.mock('../feature/run-feature', () => ({ runFeature }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const configDir = 'test-project/src/main/java/com/example/config';

/** A server with an integrated frontend that passes the install guard of the feature. */
function createServerTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  addProjectConfiguration(tree, 'server', {
    root: 'test-project',
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  tree.write(
    `${configDir}/ConfigController.java`,
    '@Value("${app.proxy.enabled:false}")',
  );
  tree.write(`${configDir}/FhirServers.java`, 'class FhirServers {}');
  addProjectConfiguration(tree, 'frontend', {
    root: 'frontend',
    projectType: 'application',
    targets: {
      'copy-to-server': {
        executor: 'nx:run-commands',
        options: {
          commands: [
            'cpy "dist/**" "../test-project/src/main/resources/static" --cwd=.',
          ],
        },
      },
    },
  });
  tree.write(
    'frontend/src/lib/fhir-config.ts',
    'export function toRequestUrl() {}\n',
  );
  return tree;
}

describe('feature-frontend-proxy generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
    isInteractive.mockReturnValue(false);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('forwards only defined options to runFeature', async () => {
    await featureFrontendProxyGenerator(tree, {
      project: 'server',
      passthrough: true,
    });
    await featureFrontendProxyGenerator(tree, {
      project: 'server',
      passthrough: undefined,
    });

    expect(runFeature).toHaveBeenNthCalledWith(1, tree, {
      feature: 'frontend-proxy',
      project: 'server',
      options: { passthrough: true },
    });
    expect(runFeature).toHaveBeenNthCalledWith(2, tree, {
      feature: 'frontend-proxy',
      project: 'server',
      options: {},
    });
  });

  it('is listed in the feature registry', () => {
    expect(FEATURES).toContain(frontendProxyFeature);
  });

  it('keeps schema.json defaults aligned with collectOptions', async () => {
    const schema = JSON.parse(
      readFileSync(join(__dirname, 'schema.json'), 'utf-8'),
    );

    const options = await frontendProxyFeature.collectOptions(
      tree,
      readProjectConfiguration(tree, 'server') as ServerProjectConfiguration,
      {},
    );

    expect(schema.properties.passthrough.default).toBe(false);
    expect(options.passthrough).toBe(schema.properties.passthrough.default);
  });
});
