import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';
import { parseDocument } from 'yaml';

import { authScopesFeature } from './auth-scopes';
import { DEFAULT_ISSUER } from '../feature-auth-resource/auth-resource';
import { runFeature } from '../feature/run-feature';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const { input, select, confirm } = vi.hoisted(() => ({
  input: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({ input, select, confirm }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const serverRoot = 'test-project';
const javaRoot = `${serverRoot}/src/main/java/com/example`;
const javaTestRoot = `${serverRoot}/src/test/java/com/example`;
const yamlPath = `${serverRoot}/src/main/resources/application.yaml`;
const testConfigPath = `${serverRoot}/src/test/resources/config/application.yaml`;
const testProfilePath = `${serverRoot}/src/test/resources/application-test.yaml`;
const pomPath = `${serverRoot}/pom.xml`;
const docPath = `${serverRoot}/AUTH-SCOPES.md`;
const starterYaml = 'hapi:\n  fhir:\n    fhir_version: R4\n';
const authResourceYaml = `${starterYaml}app:\n  auth:\n    enabled: true\n    issuer: ${DEFAULT_ISSUER}\n`;

function starterPom(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>ca.uhn.hapi.fhir</groupId>
        <artifactId>hapi-fhir</artifactId>
        <version>8.12.0</version>
    </parent>
    <artifactId>hapi-fhir-jpaserver-starter</artifactId>
</project>
`;
}

/** Returns a tree with one server project. With withAuthResource, its manifest and its main yaml show an auth-resource install. */
function createServerTree(withAuthResource = true): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(pomPath, starterPom());
  tree.write(yamlPath, withAuthResource ? authResourceYaml : starterYaml);
  addProjectConfiguration(tree, 'server', {
    root: serverRoot,
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
    ...(withAuthResource
      ? {
          features: {
            'auth-resource': {
              version: 1,
              options: { issuer: DEFAULT_ISSUER },
            },
          },
        }
      : {}),
  } as ServerProjectConfiguration);
  return tree;
}

function serverProject(tree: Tree): ServerProjectConfiguration {
  return readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
}

function readYaml(tree: Tree, file = yamlPath) {
  return parseDocument(tree.read(file, 'utf-8') as string).toJS();
}

/** Each path and content that the tree holds, for a check that a refusal writes nothing. */
function treeState(tree: Tree) {
  return tree
    .listChanges()
    .map((change) => [change.path, change.type, change.content?.toString()]);
}

describe('auth-scopes feature', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
    isInteractive.mockReturnValue(false);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('writes the Java files, the tests, AUTH-SCOPES.md, and app.auth.scopes', async () => {
    await authScopesFeature.apply(
      tree,
      { ...serverProject(tree), fhirVersion: FhirVersion.R5 },
      {},
    );

    const main = [
      'PatientSearchNarrowingInterceptor',
      'ScopeAuthorizationInterceptor',
      'ScopeConfig',
      'ScopeProperties',
      'SmartScope',
    ];
    const tests = ['AuthScopesIT', 'SmartScopeTest'];
    const javaFiles = [
      ...main.map((name) => `${javaRoot}/scopes/${name}.java`),
      ...tests.map((name) => `${javaTestRoot}/scopes/${name}.java`),
    ];
    for (const file of [...javaFiles, docPath]) {
      const content = tree.read(file, 'utf-8');
      expect(content, `${file} should exist`).not.toBeNull();
      expect(content).not.toContain('<%');
    }
    for (const file of javaFiles) {
      expect(tree.read(file, 'utf-8')).toContain('package com.example.scopes;');
    }
    expect(tree.children(`${javaRoot}/scopes`)).toHaveLength(main.length);
    expect(tree.children(`${javaTestRoot}/scopes`)).toHaveLength(tests.length);
    const integrationTest = tree.read(
      `${javaTestRoot}/scopes/AuthScopesIT.java`,
      'utf-8',
    );
    expect(integrationTest).toContain('@ActiveProfiles("test")');
    expect(integrationTest).toContain('"hapi.fhir.fhir_version=R5"');
    expect(readYaml(tree).app.auth.scopes).toEqual({ enabled: true });
    for (const file of [testConfigPath, testProfilePath]) {
      expect(readYaml(tree, file).app.auth.scopes).toEqual({ enabled: false });
    }
  });

  it.each([
    [['auth-scopes']],
    [['auth-udap', 'auth-scopes', 'auth-smart']],
    [['auth-scopes', 'auth-smart', 'auth-udap']],
    [['auth-scopes', 'auth-udap', 'auth-smart']],
  ])(
    'keeps one bypass-header line that is a key of app.auth (%j)',
    async (order) => {
      tree = createServerTree(false);

      for (const feature of order) {
        await runFeature(tree, { feature, project: 'server' });
      }

      const text = tree.read(yamlPath, 'utf-8') as string;
      expect(text.match(/# bypass-header: X-Bypass-Auth/g)).toHaveLength(1);
      const bypassOn = parseDocument(
        text.replace('# bypass-header:', 'bypass-header:'),
      );
      expect(bypassOn.errors).toEqual([]);
      const { auth } = bypassOn.toJS().app;
      expect(auth['bypass-header']).toBe('X-Bypass-Auth');
      expect(auth.scopes).toEqual({ enabled: true });
      expect(Object.keys(serverProject(tree).features ?? {})).toEqual([
        'auth-resource',
        ...order,
      ]);
    },
  );

  it('refuses when a file exists', async () => {
    tree.write(`${javaRoot}/scopes/ScopeConfig.java`, 'hand written');
    tree.write(docPath, 'hand written');
    const before = treeState(tree);

    const result = authScopesFeature.apply(tree, serverProject(tree), {});

    await expect(result).rejects.toThrow(`${javaRoot}/scopes/ScopeConfig.java`);
    await expect(result).rejects.toThrow(docPath);
    expect(treeState(tree)).toEqual(before);
  });
});
