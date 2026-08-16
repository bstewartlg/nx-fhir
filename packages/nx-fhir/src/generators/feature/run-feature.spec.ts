import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
  updateProjectConfiguration,
} from '@nx/devkit';
import { runFeature } from './run-feature';
import { FeatureDefinition } from './types';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const select = vi.hoisted(() => vi.fn());
const input = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ select, input }));

function hapiPom(version: string): string {
  return `<project><parent><groupId>ca.uhn.hapi.fhir</groupId><artifactId>hapi-fhir</artifactId><version>${version}</version></parent></project>`;
}

function createServerTree(pom = hapiPom('8.4.0')): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('test-project/src/main/java/.gitkeep', '');
  tree.write('test-project/pom.xml', pom);
  addProjectConfiguration(tree, 'server', {
    root: 'test-project',
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  return tree;
}

function stubFeature(overrides: Partial<FeatureDefinition> = {}): FeatureDefinition {
  return {
    name: 'stub',
    description: 'stub feature',
    featureVersion: 1,
    minHapiVersion: '8.0.0',
    collectOptions: vi.fn(async (_t, _p, provided) => ({ ...provided, answered: true })),
    apply: vi.fn(async (tree, project) => {
      tree.write(`${project.root}/stub.txt`, 'ok');
    }),
    ...overrides,
  };
}

describe('runFeature', () => {
  afterEach(() => vi.resetAllMocks());

  it('runs collectOptions then apply and records the manifest', async () => {
    const tree = createServerTree();
    const feature = stubFeature();
    await runFeature(tree, { feature: 'stub', project: 'server', options: { a: 1 } }, [feature]);
    expect(feature.collectOptions).toHaveBeenCalledWith(tree, expect.objectContaining({ root: 'test-project' }), { a: 1 });
    expect(tree.read('test-project/stub.txt', 'utf-8')).toBe('ok');
    const config = readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
    expect(config.features).toEqual({ stub: { version: 1, options: { a: 1, answered: true } } });
  });

  it('keeps the project configuration apply writes', async () => {
    const tree = createServerTree();
    const feature = stubFeature({
      apply: vi.fn(async (t, p) => {
        const config = readProjectConfiguration(t, 'server');
        config.targets = { ...(config.targets ?? {}), 'stub-target': { executor: 'nx:noop' } };
        updateProjectConfiguration(t, 'server', config);
        expect(p.root).toBe('test-project');
      }),
    });
    await runFeature(tree, { feature: 'stub', project: 'server' }, [feature]);
    const config = readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
    expect(config.targets?.['stub-target']).toEqual({ executor: 'nx:noop' });
    expect(config.features?.stub).toEqual({ version: 1, options: { answered: true } });
  });

  it('throws for an unknown feature and lists the registry', async () => {
    const tree = createServerTree();
    await expect(
      runFeature(tree, { feature: 'nope', project: 'server' }, [stubFeature()])
    ).rejects.toThrow("Unknown feature 'nope'. Available features: stub");
  });

  it('throws when the feature is already installed', async () => {
    const tree = createServerTree();
    const feature = stubFeature();
    await runFeature(tree, { feature: 'stub', project: 'server' }, [feature]);
    await expect(
      runFeature(tree, { feature: 'stub', project: 'server' }, [feature])
    ).rejects.toThrow("Feature 'stub' is already installed on project 'server'.");
    expect(feature.apply).toHaveBeenCalledTimes(1);
  });

  it('does not record the manifest when apply throws', async () => {
    const tree = createServerTree();
    const feature = stubFeature({ apply: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(runFeature(tree, { feature: 'stub', project: 'server' }, [feature])).rejects.toThrow('boom');
    const config = readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
    expect(config.features).toBeUndefined();
  });

  it('throws when the named project is not a server project', async () => {
    const tree = createServerTree();
    addProjectConfiguration(tree, 'web', { root: 'web-project', projectType: 'application' });
    const feature = stubFeature();
    await expect(
      runFeature(tree, { feature: 'stub', project: 'web' }, [feature])
    ).rejects.toThrow("Project 'web' is not a server project.");
    expect(feature.collectOptions).not.toHaveBeenCalled();
    expect(feature.apply).not.toHaveBeenCalled();
  });

  it('resolves the project via the server prompt when not given', async () => {
    const tree = createServerTree();
    await runFeature(tree, { feature: 'stub' }, [stubFeature()]);
    const config = readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
    expect(config.features?.stub).toBeDefined();
  });

  describe('HAPI compatibility gate', () => {
    it('rejects a server below the feature floor without writing anything', async () => {
      const tree = createServerTree(hapiPom('7.6.0'));
      const feature = stubFeature();
      await expect(
        runFeature(tree, { feature: 'stub', project: 'server' }, [feature])
      ).rejects.toThrow(/supports HAPI FHIR 8\.0\.0 and later.*builds against HAPI FHIR 7\.6\.0/);
      expect(feature.collectOptions).not.toHaveBeenCalled();
      expect(feature.apply).not.toHaveBeenCalled();
      expect(tree.exists('test-project/stub.txt')).toBe(false);
      const config = readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
      expect(config.features).toBeUndefined();
    });

    it('installs on a server exactly at the feature floor', async () => {
      const tree = createServerTree(hapiPom('8.0.0'));
      await runFeature(tree, { feature: 'stub', project: 'server' }, [stubFeature()]);
      const config = readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
      expect(config.features?.stub).toBeDefined();
    });

    it('rejects a server above the feature ceiling', async () => {
      const tree = createServerTree(hapiPom('8.10.0'));
      const feature = stubFeature({ maxHapiVersion: '8.6.0' });
      await expect(
        runFeature(tree, { feature: 'stub', project: 'server' }, [feature])
      ).rejects.toThrow(
        /supports HAPI FHIR 8\.0\.0 through 8\.6\.0.*builds against HAPI FHIR 8\.10\.0/
      );
      expect(feature.apply).not.toHaveBeenCalled();
    });

    it('warns and installs when the pom names no HAPI parent', async () => {
      const tree = createServerTree('<project></project>');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await runFeature(tree, { feature: 'stub', project: 'server' }, [stubFeature()]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Cannot check HAPI FHIR compatibility')
      );
      const config = readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
      expect(config.features?.stub).toBeDefined();
    });

    it('warns and installs when the pom is unparseable', async () => {
      const tree = createServerTree('<project><parent>');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await runFeature(tree, { feature: 'stub', project: 'server' }, [stubFeature()]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('test-project/pom.xml names no HAPI FHIR parent version')
      );
      const config = readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
      expect(config.features?.stub).toBeDefined();
    });
  });
});
