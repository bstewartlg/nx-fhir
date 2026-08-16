import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';
import { parseDocument } from 'yaml';

import { bulkPublishFeature } from './bulk-publish';
import { runFeature } from '../feature/run-feature';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const input = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ input, confirm }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const javaRoot = 'test-project/src/main/java/com/example';
const javaTestRoot = 'test-project/src/test/java/com/example';
const yamlPath = 'test-project/src/main/resources/application.yaml';

const generatedTestPaths = [
  `${javaTestRoot}/publish/BulkPublishIT.java`,
  `${javaTestRoot}/publish/PublishServiceTest.java`,
  `${javaTestRoot}/publish/SnapshotMetaJsonTest.java`,
];

const generatedPaths = [
  `${javaRoot}/common/NdjsonFiles.java`,
  `${javaRoot}/common/PathUtils.java`,
  `${javaRoot}/providers/BulkPublishProvider.java`,
  `${javaRoot}/publish/BulkPublishManifestJson.java`,
  `${javaRoot}/publish/PublishConfig.java`,
  `${javaRoot}/publish/PublishProperties.java`,
  `${javaRoot}/publish/PublishService.java`,
  `${javaRoot}/publish/web/PublishFileController.java`,
];

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

function serverProject(tree: Tree): ServerProjectConfiguration {
  return readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
}

const resolvedOptions = {
  resourceTypes: ['Organization', 'Location'],
  intervalMs: 30000,
  transactionLagMs: 15000,
  storagePath: './pub',
  resetOnStartup: false,
};

describe('bulk-publish feature', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
    isInteractive.mockReturnValue(false);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('collectOptions', () => {
    it('echoes fully provided options without prompting', async () => {
      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        {
          resourceTypes: 'Organization,Location',
          intervalMs: 30000,
          transactionLagMs: 15000,
          storagePath: './pub',
          resetOnStartup: false,
        },
      );

      expect(options).toEqual(resolvedOptions);
      expect(input).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    });

    it('resolves omitted resourceTypes to the empty list in a non-interactive run', async () => {
      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        {
          intervalMs: 30000,
          transactionLagMs: 15000,
          storagePath: './pub',
          resetOnStartup: false,
        },
      );

      expect(options.resourceTypes).toEqual([]);
    });

    it.each([
      ['false', false],
      ['true', true],
      ['FALSE', false],
      ['True', true],
    ])('reads the uncoerced resetOnStartup string %s as %s', async (given, expected) => {
      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        { resetOnStartup: given },
      );

      expect(options.resetOnStartup).toBe(expected);
    });

    it.each([['no'], [0]])(
      'rejects the resetOnStartup value %s',
      async (given) => {
        await expect(
          bulkPublishFeature.collectOptions(tree, serverProject(tree), {
            resetOnStartup: given,
          }),
        ).rejects.toThrow(
          `Invalid resetOnStartup '${given}'. Provide true or false.`,
        );
      },
    );

    it('rejects a resource type that is not a FHIR type name', async () => {
      await expect(
        bulkPublishFeature.collectOptions(tree, serverProject(tree), {
          resourceTypes: 'Organization,bad-type',
        }),
      ).rejects.toThrow(
        "Invalid resource type 'bad-type'. Resource types must match [A-Z][A-Za-z]*.",
      );
    });

    it.each([
      ['a bare OperationOutcome entry', 'Organization,OperationOutcome'],
      ['a filtered OperationOutcome entry', 'OperationOutcome?_id=1'],
    ])('rejects %s', async (_name, resourceTypes) => {
      await expect(
        bulkPublishFeature.collectOptions(tree, serverProject(tree), {
          resourceTypes,
        }),
      ).rejects.toThrow(
        "Resource type 'OperationOutcome' is reserved for the manifest outcome property.",
      );
    });

    it('resolves a separators-only resourceTypes value to the empty list', async () => {
      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        { ...resolvedOptions, resourceTypes: ',' },
      );

      expect(options.resourceTypes).toEqual([]);
    });

    it('collapses a resource type named more than once', async () => {
      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        { ...resolvedOptions, resourceTypes: 'Organization,Organization,Location' },
      );

      expect(options.resourceTypes).toEqual(['Organization', 'Location']);
    });

    it('keeps a search filter carried by a resource type entry', async () => {
      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        {
          ...resolvedOptions,
          resourceTypes: 'Organization,Patient?active=true',
        },
      );

      expect(options.resourceTypes).toEqual([
        'Organization',
        'Patient?active=true',
      ]);
    });

    it('normalizes an entry ending in a bare question mark to the type', async () => {
      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        { ...resolvedOptions, resourceTypes: 'Patient?' },
      );

      expect(options.resourceTypes).toEqual(['Patient']);
    });

    it('rejects a filter that sets a parameter the publisher controls', async () => {
      await expect(
        bulkPublishFeature.collectOptions(tree, serverProject(tree), {
          ...resolvedOptions,
          resourceTypes: 'Patient?_sort=name',
        }),
      ).rejects.toThrow(
        "Filter for resource type 'Patient' must not set '_sort'. The publisher controls it.",
      );
    });

    it('rejects two entries that share a base resource type', async () => {
      await expect(
        bulkPublishFeature.collectOptions(tree, serverProject(tree), {
          ...resolvedOptions,
          resourceTypes: 'Patient?active=true,Patient?gender=male',
        }),
      ).rejects.toThrow(
        "Resource type 'Patient' is configured more than once. Combine filters into one entry.",
      );
    });

    it.each([
      ['a filter value left empty', 'Patient?active='],
      ['a filter parameter with no value at all', 'Patient?active'],
    ])('rejects %s', async (_name, resourceTypes) => {
      await expect(
        bulkPublishFeature.collectOptions(tree, serverProject(tree), {
          ...resolvedOptions,
          resourceTypes,
        }),
      ).rejects.toThrow(
        "Filter for resource type 'Patient' must give 'active' a value.",
      );
    });

    it('rejects a filter containing whitespace', async () => {
      await expect(
        bulkPublishFeature.collectOptions(tree, serverProject(tree), {
          ...resolvedOptions,
          resourceTypes: 'Patient? active=true',
        }),
      ).rejects.toThrow(
        "Invalid filter for resource type 'Patient'. Provide search parameters after '?', e.g. Patient?active=true.",
      );
    });

    it.each([
      ['an intervalMs of zero', { intervalMs: 0 }, "Invalid intervalMs '0'."],
      [
        'a fractional intervalMs',
        { intervalMs: 1.5 },
        "Invalid intervalMs '1.5'.",
      ],
      [
        'a negative transactionLagMs',
        { transactionLagMs: -1 },
        "Invalid transactionLagMs '-1'.",
      ],
    ])('rejects %s', async (_name, override, message) => {
      await expect(
        bulkPublishFeature.collectOptions(tree, serverProject(tree), {
          ...resolvedOptions,
          resourceTypes: 'Organization',
          ...override,
        }),
      ).rejects.toThrow(message);
    });

    it('keeps a provided publicBaseUrl', async () => {
      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        { ...resolvedOptions, publicBaseUrl: 'https://fhir.example.org' },
      );

      expect(options).toEqual({
        ...resolvedOptions,
        publicBaseUrl: 'https://fhir.example.org',
      });
    });

    it('prompts for every option and applies the defaults in an interactive run', async () => {
      isInteractive.mockReturnValue(true);
      input
        .mockResolvedValueOnce('Organization, Location')
        .mockImplementationOnce(async (q) => q.default)
        .mockImplementationOnce(async (q) => q.default)
        .mockImplementationOnce(async (q) => q.default);
      confirm.mockImplementationOnce(async (q) => q.default);

      const options = await bulkPublishFeature.collectOptions(
        tree,
        serverProject(tree),
        {},
      );

      expect(input.mock.calls[0][0].message).toContain(
        'each entry may carry a search filter',
      );
      expect(input.mock.calls[0][0].message).toContain(
        'leave empty to publish every supported type',
      );
      expect(input.mock.calls[0][0].required).toBeUndefined();
      expect(options).toEqual({
        resourceTypes: ['Organization', 'Location'],
        intervalMs: 60000,
        transactionLagMs: 60000,
        storagePath: './publish-data',
        resetOnStartup: false,
      });
    });
  });

  describe('apply', () => {
    it('writes every template file and the publish configuration', async () => {
      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
      });

      for (const file of generatedPaths) {
        expect(tree.exists(file), `${file} should exist`).toBe(true);
      }

      const provider = tree.read(
        `${javaRoot}/providers/BulkPublishProvider.java`,
        'utf-8',
      );
      expect(provider).toContain('package com.example.providers;');
      expect(provider).toContain('name = "$bulk-publish"');

      const service = tree.read(`${javaRoot}/publish/PublishService.java`, 'utf-8');
      expect(service).toContain('package com.example.publish;');
      expect(service).not.toContain('org.hl7.davinci');

      expect(tree.read(`${javaRoot}/publish/PublishConfig.java`, 'utf-8')).toContain(
        '@EnableScheduling',
      );

      const config = parseDocument(tree.read(yamlPath, 'utf-8')).toJS();
      expect(config.publish).toEqual({
        enabled: true,
        'interval-ms': 30000,
        'transaction-lag-ms': 15000,
        'storage-path': './pub',
        'reset-on-startup': false,
        'resource-types': ['Organization', 'Location'],
      });
      expect(config.hapi.fhir.expunge_enabled).toBeUndefined();
      expect(config.hapi.fhir.delete_expunge_enabled).toBeUndefined();
    });

    it('writes the Maven test sources into the server test tree', async () => {
      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
      });

      for (const file of generatedTestPaths) {
        const contents = tree.read(file, 'utf-8');
        expect(contents, `${file} should exist`).not.toBeNull();
        expect(contents).toContain('package com.example.publish;');
        expect(contents).not.toContain('org.hl7.davinci');
      }

      const integrationTest = tree.read(
        `${javaTestRoot}/publish/BulkPublishIT.java`,
        'utf-8',
      );
      expect(integrationTest).toContain('"publish.transaction-lag-ms=0"');
      expect(integrationTest).toContain('classes = {Application.class}');
    });

    it('writes a filtered resource type entry into the publish configuration', async () => {
      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
        resourceTypes: ['Organization', 'Patient?active=true'],
      });

      const config = parseDocument(tree.read(yamlPath, 'utf-8')).toJS();
      expect(config.publish['resource-types']).toEqual([
        'Organization',
        'Patient?active=true',
      ]);
    });

    it('writes an empty resource-types list when no type is configured', async () => {
      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
        resourceTypes: [],
      });

      const config = parseDocument(tree.read(yamlPath, 'utf-8')).toJS();
      expect(config.publish['resource-types']).toEqual([]);
    });

    it('writes public-base-url only when the option is set', async () => {
      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
        publicBaseUrl: 'https://fhir.example.org',
      });

      const config = parseDocument(tree.read(yamlPath, 'utf-8')).toJS();
      expect(config.publish['public-base-url']).toBe('https://fhir.example.org');
    });

    it('creates the server wiring an imported server is missing', async () => {
      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
      });

      expect(tree.read(`${javaRoot}/common/BaseProvider.java`, 'utf-8')).toContain(
        'package com.example.common;',
      );
      expect(
        tree.read(
          'test-project/src/main/java/ca/uhn/fhir/jpa/starter/CustomServerConfig.java',
          'utf-8',
        ),
      ).toContain('@ComponentScan(basePackages = {"com.example"})');
    });

    it('keeps publish settings the server already had', async () => {
      tree.write(
        yamlPath,
        'hapi:\n  fhir:\n    fhir_version: R4\npublish:\n  retention: 5\n  custom-key: keep\n',
      );

      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
      });

      const config = parseDocument(tree.read(yamlPath, 'utf-8')).toJS();
      expect(config.publish).toEqual({
        retention: 5,
        'custom-key': 'keep',
        enabled: true,
        'interval-ms': 30000,
        'transaction-lag-ms': 15000,
        'storage-path': './pub',
        'reset-on-startup': false,
        'resource-types': ['Organization', 'Location'],
      });
    });

    it('refuses to overwrite a file the server already has', async () => {
      tree.write(`${javaRoot}/common/PathUtils.java`, 'hand written');

      await expect(
        bulkPublishFeature.apply(tree, serverProject(tree), {
          ...resolvedOptions,
        }),
      ).rejects.toThrow(`${javaRoot}/common/PathUtils.java`);

      expect(tree.read(`${javaRoot}/common/PathUtils.java`, 'utf-8')).toBe(
        'hand written',
      );
    });

    it('gitignores the snapshot storage path', async () => {
      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
      });

      expect(tree.read('test-project/.gitignore', 'utf-8')).toBe('pub/\n');
    });

    it('leaves an already ignored storage path listed once', async () => {
      tree.write('test-project/.gitignore', 'target/\npub/\n');

      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
      });

      expect(tree.read('test-project/.gitignore', 'utf-8')).toBe('target/\npub/\n');
    });

    it('leaves a storage path ignored without a trailing slash listed once', async () => {
      tree.write('test-project/.gitignore', 'target/\npub\n');

      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
      });

      expect(tree.read('test-project/.gitignore', 'utf-8')).toBe('target/\npub\n');
    });

    it('leaves .gitignore untouched for an absolute storage path', async () => {
      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
        storagePath: '/var/lib/fhir-publish',
      });

      expect(tree.exists('test-project/.gitignore')).toBe(false);
    });

    it('leaves existing server wiring byte-identical', async () => {
      const customConfigPath =
        'test-project/src/main/java/ca/uhn/fhir/jpa/starter/CustomServerConfig.java';
      tree.write(`${javaRoot}/common/BaseProvider.java`, 'base provider marker');
      tree.write(customConfigPath, 'custom config marker');

      await bulkPublishFeature.apply(tree, serverProject(tree), {
        ...resolvedOptions,
      });

      expect(tree.read(`${javaRoot}/common/BaseProvider.java`, 'utf-8')).toBe(
        'base provider marker',
      );
      expect(tree.read(customConfigPath, 'utf-8')).toBe('custom config marker');
    });
  });

  it('installs through runFeature against the real registry', async () => {
    await runFeature(tree, {
      feature: 'bulk-publish',
      project: 'server',
      options: {
        resourceTypes: 'Organization,Location',
        intervalMs: 30000,
        transactionLagMs: 15000,
        storagePath: './pub',
        resetOnStartup: false,
      },
    });

    expect(serverProject(tree).features).toEqual({
      'bulk-publish': { version: 1, options: resolvedOptions },
    });
    expect(tree.exists(`${javaRoot}/publish/PublishService.java`)).toBe(true);
  });

  it('records no feature manifest when a file collision aborts the install', async () => {
    tree.write(`${javaRoot}/common/PathUtils.java`, 'hand written');

    await expect(
      runFeature(tree, {
        feature: 'bulk-publish',
        project: 'server',
        options: {
          resourceTypes: 'Organization,Location',
          intervalMs: 30000,
          transactionLagMs: 15000,
          storagePath: './pub',
          resetOnStartup: false,
        },
      }),
    ).rejects.toThrow(`${javaRoot}/common/PathUtils.java`);

    expect(serverProject(tree).features).toBeUndefined();
  });
});
