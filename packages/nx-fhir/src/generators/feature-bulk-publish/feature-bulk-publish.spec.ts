import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';
import { parseDocument } from 'yaml';
import { readFileSync } from 'fs';
import { join } from 'path';

import { featureBulkPublishGenerator } from './feature-bulk-publish';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const javaRoot = 'test-project/src/main/java/com/example';
const yamlPath = 'test-project/src/main/resources/application.yaml';

function createServerTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('test-project/src/main/java/.gitkeep', '');
  tree.write(
    'test-project/pom.xml',
    '<project><parent><groupId>ca.uhn.hapi.fhir</groupId><artifactId>hapi-fhir</artifactId><version>8.4.0</version></parent></project>',
  );
  tree.write(yamlPath, 'hapi:\n  fhir:\n    fhir_version: R4\n');
  addProjectConfiguration(tree, 'server', {
    root: 'test-project',
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  return tree;
}

function publishConfig(tree: Tree): Record<string, unknown> {
  return parseDocument(tree.read(yamlPath, 'utf-8')).toJS().publish;
}

describe('feature-bulk-publish generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
    isInteractive.mockReturnValue(false);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('installs the feature from explicit flags', async () => {
    await featureBulkPublishGenerator(tree, {
      project: 'server',
      resourceTypes: 'Organization,Location',
      intervalMs: 30000,
      transactionLagMs: 15000,
      storagePath: './pub',
      resetOnStartup: false,
    });

    expect(
      tree.read(`${javaRoot}/providers/BulkPublishProvider.java`, 'utf-8'),
    ).toContain('name = "$bulk-publish"');
    expect(publishConfig(tree)['interval-ms']).toBe(30000);
    expect(
      (readProjectConfiguration(tree, 'server') as ServerProjectConfiguration)
        .features,
    ).toEqual({
      'bulk-publish': {
        version: 1,
        options: {
          resourceTypes: ['Organization', 'Location'],
          intervalMs: 30000,
          transactionLagMs: 15000,
          storagePath: './pub',
          resetOnStartup: false,
        },
      },
    });
  });

  it('records an explicit resetOnStartup of false', async () => {
    await featureBulkPublishGenerator(tree, {
      project: 'server',
      resourceTypes: 'Organization',
      resetOnStartup: false,
    });

    expect(publishConfig(tree)['reset-on-startup']).toBe(false);
    expect(
      (readProjectConfiguration(tree, 'server') as ServerProjectConfiguration)
        .features?.['bulk-publish'].options.resetOnStartup,
    ).toBe(false);
  });

  it('falls back to the feature defaults for undefined options', async () => {
    await featureBulkPublishGenerator(tree, {
      project: 'server',
      resourceTypes: 'Organization',
      intervalMs: undefined,
      storagePath: undefined,
    });

    expect(publishConfig(tree)['interval-ms']).toBe(60000);
    expect(publishConfig(tree)['storage-path']).toBe('./publish-data');
  });

  it('keeps the schema defaults aligned with the feature defaults', async () => {
    const schema = JSON.parse(
      readFileSync(join(__dirname, 'schema.json'), 'utf-8'),
    );

    await featureBulkPublishGenerator(tree, {
      project: 'server',
      resourceTypes: 'Organization',
    });

    const { options } = (
      readProjectConfiguration(tree, 'server') as ServerProjectConfiguration
    ).features['bulk-publish'];
    expect({
      intervalMs: schema.properties.intervalMs.default,
      transactionLagMs: schema.properties.transactionLagMs.default,
      storagePath: schema.properties.storagePath.default,
      resetOnStartup: schema.properties.resetOnStartup.default,
    }).toEqual({
      intervalMs: options.intervalMs,
      transactionLagMs: options.transactionLagMs,
      storagePath: options.storagePath,
      resetOnStartup: options.resetOnStartup,
    });
  });

  it('rejects a non-interactive run that omits resourceTypes without allTypes', async () => {
    await expect(
      featureBulkPublishGenerator(tree, { project: 'server' }),
    ).rejects.toThrow(
      'No resource types provided. Provide resourceTypes, or set allTypes to publish every type the server supports.',
    );
  });

  it('publishes every supported type when a non-interactive run sets allTypes', async () => {
    await featureBulkPublishGenerator(tree, { project: 'server', allTypes: true });

    expect(publishConfig(tree)['resource-types']).toEqual([]);
  });
});
