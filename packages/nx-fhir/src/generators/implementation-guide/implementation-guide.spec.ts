import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, logger } from '@nx/devkit';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { Document, parseDocument } from 'yaml';

import { ImplementationGuideGeneratorSchema } from './schema';
import { ServerProjectConfiguration } from '../../shared/models';

const select = vi.hoisted(() => vi.fn());
const input = vi.hoisted(() => vi.fn());
const checkbox = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());

vi.mock('@inquirer/prompts', () => ({ select, input, checkbox, confirm }));

import { implementationGuideGenerator } from './implementation-guide';

const projectName = 'test';
const projectRoot = 'test-project';
const yamlPath = `${projectRoot}/src/main/resources/application.yaml`;
const javaRoot = `${projectRoot}/src/main/java`;

const IG_ID = 'example.fhir.testig';
const IG_KEY = 'examplefhirtestig';
const IG_VERSION = '2.1.0';

const implementationGuideResource = JSON.stringify({
  resourceType: 'ImplementationGuide',
  id: IG_ID,
  version: IG_VERSION,
  name: 'TestIg',
  status: 'active',
});

const packageManifest = JSON.stringify({
  name: IG_ID,
  version: IG_VERSION,
  type: 'fhir.ig',
});

const systemOperation = JSON.stringify({
  resourceType: 'OperationDefinition',
  id: 'do-thing',
  name: 'DoThing',
  code: 'do-thing',
  status: 'active',
  kind: 'operation',
  system: true,
  type: false,
  instance: false,
  parameter: [{ name: 'subject', use: 'in', min: 0, max: '1', type: 'string' }],
});

const typeOperation = JSON.stringify({
  resourceType: 'OperationDefinition',
  id: 'read-thing',
  name: 'ReadThing',
  code: 'read-thing',
  status: 'active',
  kind: 'operation',
  system: false,
  type: true,
  instance: false,
  resource: ['Patient'],
});

const primaryCapabilityStatement = JSON.stringify({
  resourceType: 'CapabilityStatement',
  id: 'primary-cs',
  status: 'active',
  kind: 'requirements',
  title: 'Primary',
});

const secondaryCapabilityStatement = JSON.stringify({
  resourceType: 'CapabilityStatement',
  id: 'secondary-cs',
  status: 'active',
  kind: 'requirements',
  title: 'Secondary',
});

let fixtureRoot: string;
let fullPackage: string;
let operationsPackage: string;
let noGuidePackage: string;
let plainPackage: string;
let twoStatementsPackage: string;
let customCapabilityStatementFile: string;

/** Build a FHIR package tgz that holds the given files under the package/ directory. */
function createPackageTgz(name: string, files: Record<string, string>): string {
  const stagingDir = path.join(fixtureRoot, name);
  mkdirSync(path.join(stagingDir, 'package'), { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(path.join(stagingDir, 'package', fileName), content);
  }
  const tgzPath = path.join(fixtureRoot, `${name}.tgz`);
  tar.create({ sync: true, gzip: true, cwd: stagingDir, file: tgzPath }, ['package']);
  return tgzPath;
}

function createTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  addProjectConfiguration(tree, projectName, {
    root: projectRoot,
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: 'R4',
  } as ServerProjectConfiguration);
  tree.write(`${projectRoot}/pom.xml`, '<project></project>');

  const doc = new Document({
    hapi: {
      fhir: {
        implementationguides: {
          initialguide: {
            name: 'some.initial.guide',
            version: '1.0.0',
            install: 'STORE_ONLY',
          },
        },
      },
    },
  });
  tree.write(yamlPath, doc.toString());
  tree.write(`${javaRoot}/com/example/Application.java`, 'package com.example;');
  return tree;
}

function readGuides(tree: Tree): Record<string, Record<string, string>> {
  const doc = parseDocument(tree.read(yamlPath, 'utf-8') || '');
  return doc.toJSON().hapi.fhir.implementationguides;
}

function baseOptions(
  overrides: Partial<ImplementationGuideGeneratorSchema> = {},
): ImplementationGuideGeneratorSchema {
  return {
    project: projectName,
    id: IG_ID,
    igVersion: IG_VERSION,
    install: true,
    skipOps: true,
    skipCs: true,
    validate: false,
    ...overrides,
  };
}

function okResponse(tgzPath: string) {
  const bytes = readFileSync(tgzPath);
  return {
    ok: true,
    statusText: 'OK',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe('implementation-guide generator', () => {
  let tree: Tree;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'nx-fhir-ig-'));

    fullPackage = createPackageTgz('full', {
      'package.json': packageManifest,
      'ImplementationGuide-testig.json': implementationGuideResource,
      'OperationDefinition-do-thing.json': systemOperation,
      'OperationDefinition-read-thing.json': typeOperation,
      'CapabilityStatement-primary.json': primaryCapabilityStatement,
    });

    operationsPackage = createPackageTgz('operations', {
      'package.json': packageManifest,
      'ImplementationGuide-testig.json': implementationGuideResource,
      'OperationDefinition-do-thing.json': systemOperation,
      'OperationDefinition-read-thing.json': typeOperation,
    });

    noGuidePackage = createPackageTgz('no-guide', {
      'package.json': packageManifest,
      'OperationDefinition-do-thing.json': systemOperation,
    });

    plainPackage = createPackageTgz('plain', {
      'package.json': packageManifest,
      'ImplementationGuide-testig.json': implementationGuideResource,
    });

    twoStatementsPackage = createPackageTgz('two-statements', {
      'package.json': packageManifest,
      'ImplementationGuide-testig.json': implementationGuideResource,
      'CapabilityStatement-primary.json': primaryCapabilityStatement,
      'CapabilityStatement-secondary.json': secondaryCapabilityStatement,
    });

    customCapabilityStatementFile = path.join(fixtureRoot, 'custom-cs.json');
    writeFileSync(
      customCapabilityStatementFile,
      JSON.stringify({
        resourceType: 'CapabilityStatement',
        id: 'custom-cs',
        status: 'active',
        kind: 'requirements',
      }),
    );
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    tree = createTree();
  });

  describe('server config', () => {
    it('adds the guide to application.yaml without removing existing entries', async () => {
      const before = readGuides(tree);
      expect(Object.keys(before)).toHaveLength(1);

      await implementationGuideGenerator(tree, baseOptions());

      const after = readGuides(tree);
      expect(Object.keys(after)).toHaveLength(2);
      expect(after['initialguide'].name).toBe('some.initial.guide');
      expect(after[IG_KEY]).toEqual({
        name: IG_ID,
        version: IG_VERSION,
        installMode: 'STORE_AND_INSTALL',
      });
    });

    it('stores the guide without installing it when install is not requested', async () => {
      await implementationGuideGenerator(tree, baseOptions({ install: false }));

      expect(readGuides(tree)[IG_KEY].installMode).toBe('STORE_ONLY');
    });

    it('records the package location when one is supplied', async () => {
      await implementationGuideGenerator(
        tree,
        baseOptions({ package: 'https://example.test/ig.tgz' }),
      );

      expect(readGuides(tree)[IG_KEY].packageUrl).toBe('https://example.test/ig.tgz');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses the only server project when none is given', async () => {
      const options = baseOptions();
      delete (options as Partial<ImplementationGuideGeneratorSchema>).project;

      await implementationGuideGenerator(tree, options);

      expect(select).not.toHaveBeenCalled();
      expect(readGuides(tree)[IG_KEY]).toBeDefined();
    });

    it('fails when the named project is not in the workspace', async () => {
      await expect(
        implementationGuideGenerator(tree, baseOptions({ project: 'missing' })),
      ).rejects.toThrow('Project "missing" not found in workspace.');
    });
  });

  describe('package parsing', () => {
    it('takes the id and version from the ImplementationGuide in a local package', async () => {
      await implementationGuideGenerator(
        tree,
        baseOptions({ id: 'placeholder', igVersion: '0.0.1', package: plainPackage, validate: true }),
      );

      const guides = readGuides(tree);
      expect(guides[IG_KEY]).toEqual({
        name: IG_ID,
        version: IG_VERSION,
        installMode: 'STORE_AND_INSTALL',
        packageUrl: plainPackage,
      });
      expect(guides['placeholder']).toBeUndefined();
    });

    it('downloads the package when the location is a URL', async () => {
      fetchMock.mockResolvedValue(okResponse(plainPackage));

      await implementationGuideGenerator(
        tree,
        baseOptions({ package: 'https://example.test/ig.tgz', validate: true }),
      );

      expect(fetchMock).toHaveBeenCalledWith('https://example.test/ig.tgz');
      expect(readGuides(tree)[IG_KEY].version).toBe(IG_VERSION);
    });

    it('reports a failed download and leaves the config alone', async () => {
      fetchMock.mockResolvedValue({ ok: false, statusText: 'Not Found' });

      await implementationGuideGenerator(
        tree,
        baseOptions({ package: 'https://example.test/missing.tgz', validate: true }),
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Could not fetch or parse IG package'),
      );
      expect(Object.keys(readGuides(tree))).toHaveLength(1);
    });

    it('rejects a package that holds no ImplementationGuide', async () => {
      await implementationGuideGenerator(
        tree,
        baseOptions({ package: noGuidePackage, validate: true }),
      );

      expect(logger.error).toHaveBeenCalledWith(
        'No ImplementationGuide found in the provided package, cannot proceed.',
      );
      expect(Object.keys(readGuides(tree))).toHaveLength(1);
    });

    it('looks up an id and version in the public FHIR registry', async () => {
      fetchMock.mockResolvedValue(okResponse(plainPackage));

      await implementationGuideGenerator(tree, baseOptions({ validate: true }));

      expect(fetchMock).toHaveBeenCalledWith(`https://packages.fhir.org/${IG_ID}/${IG_VERSION}`);
      expect(readGuides(tree)[IG_KEY]).toBeDefined();
    });

    it('stops when the registry lookup fails', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));

      await implementationGuideGenerator(tree, baseOptions({ validate: true }));

      expect(logger.error).toHaveBeenCalledWith('network down');
      expect(Object.keys(readGuides(tree))).toHaveLength(1);
    });
  });

  describe('operations', () => {
    it('generates only the operations selected in the prompt', async () => {
      checkbox.mockResolvedValue(['do-thing']);

      await implementationGuideGenerator(
        tree,
        baseOptions({
          package: operationsPackage,
          validate: true,
          skipOps: false,
          opDirectory: 'com/example/providers',
        }),
      );

      expect(checkbox).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: [
            { name: 'DoThing (do-thing)', value: 'do-thing' },
            { name: 'ReadThing (read-thing)', value: 'read-thing' },
          ],
        }),
      );
      expect(tree.exists(`${javaRoot}/com/example/providers/DoThingOperation.java`)).toBe(true);
      expect(tree.exists(`${javaRoot}/com/example/providers/ReadThingProvider.java`)).toBe(false);
      expect(tree.read(`${javaRoot}/com/example/providers/DoThingOperation.java`, 'utf-8')).toContain(
        'package com.example.providers;',
      );
    });

    it('keys the selection on the name fallback for operations without an id', async () => {
      const idlessPackage = createPackageTgz('idless', {
        'package.json': packageManifest,
        'ImplementationGuide-testig.json': implementationGuideResource,
        'OperationDefinition-alpha.json': JSON.stringify({
          resourceType: 'OperationDefinition',
          name: 'DoAlpha',
          code: 'do-alpha',
          status: 'active',
          kind: 'operation',
          system: true,
          type: false,
          instance: false,
        }),
        'OperationDefinition-beta.json': JSON.stringify({
          resourceType: 'OperationDefinition',
          name: 'DoBeta',
          code: 'do-beta',
          status: 'active',
          kind: 'operation',
          system: true,
          type: false,
          instance: false,
        }),
      });
      checkbox.mockResolvedValue(['DoAlpha']);

      await implementationGuideGenerator(
        tree,
        baseOptions({
          package: idlessPackage,
          validate: true,
          skipOps: false,
          opDirectory: 'com/example/providers',
        }),
      );

      expect(checkbox).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: expect.arrayContaining([
            expect.objectContaining({ value: 'DoAlpha' }),
            expect.objectContaining({ value: 'DoBeta' }),
          ]),
        }),
      );
      expect(tree.exists(`${javaRoot}/com/example/providers/DoAlphaOperation.java`)).toBe(true);
      expect(tree.exists(`${javaRoot}/com/example/providers/DoBetaOperation.java`)).toBe(false);
    });

    it('generates nothing when no operation is selected', async () => {
      checkbox.mockResolvedValue([]);

      await implementationGuideGenerator(
        tree,
        baseOptions({ package: operationsPackage, validate: true, skipOps: false }),
      );

      expect(input).not.toHaveBeenCalled();
      expect(tree.exists(`${javaRoot}/com/example/providers/DoThingOperation.java`)).toBe(false);
      expect(tree.exists(`${javaRoot}/com/example/providers/ReadThingProvider.java`)).toBe(false);
    });

    it('asks once for the operation directory and reuses the answer', async () => {
      checkbox.mockResolvedValue(['do-thing', 'read-thing']);
      input.mockResolvedValue('com/example/custom');

      await implementationGuideGenerator(
        tree,
        baseOptions({ package: operationsPackage, validate: true, skipOps: false }),
      );

      expect(input).toHaveBeenCalledTimes(1);
      expect(input).toHaveBeenCalledWith(
        expect.objectContaining({ default: path.join('com/example', 'providers') }),
      );
      expect(tree.exists(`${javaRoot}/com/example/custom/DoThingOperation.java`)).toBe(true);
      expect(tree.exists(`${javaRoot}/com/example/custom/ReadThingProvider.java`)).toBe(true);
    });

    it('does not prompt or generate when operations are skipped', async () => {
      await implementationGuideGenerator(
        tree,
        baseOptions({ package: operationsPackage, validate: true, skipOps: true }),
      );

      expect(checkbox).not.toHaveBeenCalled();
      expect(tree.exists(`${javaRoot}/com/example/providers/DoThingOperation.java`)).toBe(false);
    });

    it('reports when the package holds no operations', async () => {
      await implementationGuideGenerator(
        tree,
        baseOptions({ package: plainPackage, validate: true, skipOps: false }),
      );

      expect(checkbox).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('No operations to generate.');
    });
  });

  describe('capability statement', () => {
    const interceptorPath = `${javaRoot}/com/example/interceptors/CapabilityStatementCustomizer.java`;

    it('writes the single CapabilityStatement from the package and its interceptor', async () => {
      await implementationGuideGenerator(
        tree,
        baseOptions({ package: fullPackage, validate: true, skipCs: false }),
      );

      const statementPath = `${projectRoot}/src/main/resources/CapabilityStatement-primary-cs.json`;
      expect(tree.exists(statementPath)).toBe(true);
      expect(JSON.parse(tree.read(statementPath, 'utf-8') || '{}').id).toBe('primary-cs');

      const interceptor = tree.read(interceptorPath, 'utf-8') || '';
      expect(interceptor).toContain('String fileName = "CapabilityStatement-primary-cs.json";');
      expect(interceptor).toContain('import org.hl7.fhir.r4.model.CapabilityStatement;');
    });

    it('asks which CapabilityStatement to use when the package holds several', async () => {
      select.mockImplementation(async ({ choices }) => choices[2].value);

      await implementationGuideGenerator(
        tree,
        baseOptions({ package: twoStatementsPackage, validate: true, skipCs: false }),
      );

      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Multiple CapabilityStatements found. Select one to use:',
        }),
      );
      expect(
        tree.exists(`${projectRoot}/src/main/resources/CapabilityStatement-secondary-cs.json`),
      ).toBe(true);
      expect(tree.exists(interceptorPath)).toBe(true);
    });

    it('writes nothing when the user selects none of the CapabilityStatements', async () => {
      select.mockResolvedValue(null);

      await implementationGuideGenerator(
        tree,
        baseOptions({ package: twoStatementsPackage, validate: true, skipCs: false }),
      );

      expect(tree.exists(interceptorPath)).toBe(false);
      expect(logger.info).toHaveBeenCalledWith('No CapabilityStatement to add to the server project.');
    });

    it('prefers a CapabilityStatement given by path over the one in the package', async () => {
      await implementationGuideGenerator(
        tree,
        baseOptions({
          package: fullPackage,
          validate: true,
          skipCs: false,
          csLocation: customCapabilityStatementFile,
        }),
      );

      expect(
        tree.exists(`${projectRoot}/src/main/resources/CapabilityStatement-custom-cs.json`),
      ).toBe(true);
      expect(
        tree.exists(`${projectRoot}/src/main/resources/CapabilityStatement-primary-cs.json`),
      ).toBe(false);
    });

    it('writes no CapabilityStatement when that step is skipped', async () => {
      await implementationGuideGenerator(
        tree,
        baseOptions({ package: fullPackage, validate: true, skipCs: true }),
      );

      expect(tree.exists(interceptorPath)).toBe(false);
    });
  });

  describe('prompts for the guide source', () => {
    function promptOptions(): ImplementationGuideGeneratorSchema {
      const options = baseOptions();
      delete (options as Partial<ImplementationGuideGeneratorSchema>).id;
      delete (options as Partial<ImplementationGuideGeneratorSchema>).igVersion;
      return options;
    }

    it('stops when the user skips the guide', async () => {
      select.mockResolvedValue('skip');

      await implementationGuideGenerator(tree, promptOptions());

      expect(Object.keys(readGuides(tree))).toHaveLength(1);
      expect(logger.info).toHaveBeenCalledWith('Skipping implementation guide generation');
    });

    it('accepts an id and version typed by the user', async () => {
      select.mockResolvedValue('id');
      input.mockResolvedValueOnce(' typed.ig ').mockResolvedValueOnce(' 3.0.0 ');

      await implementationGuideGenerator(tree, promptOptions());

      expect(readGuides(tree)['typedig']).toEqual({
        name: 'typed.ig',
        version: '3.0.0',
        installMode: 'STORE_AND_INSTALL',
      });
    });

    it('accepts a package path typed by the user', async () => {
      select.mockResolvedValue('package');
      input.mockResolvedValue(plainPackage);

      await implementationGuideGenerator(tree, { ...promptOptions(), validate: true });

      expect(readGuides(tree)[IG_KEY].version).toBe(IG_VERSION);
    });

    it('stops when the user gives an empty package path', async () => {
      select.mockResolvedValue('package');
      input.mockResolvedValue('  ');

      await implementationGuideGenerator(tree, promptOptions());

      expect(Object.keys(readGuides(tree))).toHaveLength(1);
      expect(logger.info).toHaveBeenCalledWith(
        'No package or ID provided, skipping implementation guide generation.',
      );
    });
  });
});
