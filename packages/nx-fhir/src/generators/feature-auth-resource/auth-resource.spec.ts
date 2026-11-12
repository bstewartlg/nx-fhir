import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';
import { parseDocument } from 'yaml';

import { authResourceFeature } from './auth-resource';
import { runFeature } from '../feature/run-feature';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const input = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ input }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const serverRoot = 'test-project';
const javaRoot = `${serverRoot}/src/main/java/com/example`;
const javaTestRoot = `${serverRoot}/src/test/java/com/example`;
const yamlPath = `${serverRoot}/src/main/resources/application.yaml`;
const testConfigPath = `${serverRoot}/src/test/resources/config/application.yaml`;
const testProfilePath = `${serverRoot}/src/test/resources/application-test.yaml`;
const pomPath = `${serverRoot}/pom.xml`;
const docPath = `${serverRoot}/AUTH-RESOURCE.md`;
const issuer = 'https://issuer.example.org';
const audience = 'https://fhir.example.org/fhir';
const noOptions = { issuer: '', audience: '' };

function starterPom(hapiVersion: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>ca.uhn.hapi.fhir</groupId>
        <artifactId>hapi-fhir</artifactId>
        <version>${hapiVersion}</version>
    </parent>
    <artifactId>hapi-fhir-jpaserver-starter</artifactId>
    <dependencies>
        <dependency>
            <groupId>ca.uhn.hapi.fhir</groupId>
            <artifactId>hapi-fhir-base</artifactId>
        </dependency>
    </dependencies>
</project>
`;
}

function createServerTree(hapiVersion = '8.12.0'): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(pomPath, starterPom(hapiVersion));
  tree.write(yamlPath, 'hapi:\n  fhir:\n    fhir_version: R4\n');
  addProjectConfiguration(tree, 'server', {
    root: serverRoot,
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  return tree;
}

function serverProject(tree: Tree): ServerProjectConfiguration {
  return readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
}

function readYaml(tree: Tree, file = yamlPath) {
  return parseDocument(tree.read(file, 'utf-8') as string).toJS();
}

describe('auth-resource feature', () => {
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

  describe('collectOptions', () => {
    const collect = (provided: Record<string, unknown> = {}) =>
      authResourceFeature.collectOptions(tree, serverProject(tree), provided);

    it('uses empty values when not interactive', async () => {
      await expect(collect()).resolves.toEqual(noOptions);
      expect(input).not.toHaveBeenCalled();
    });

    it('takes provided values without a prompt and trims them', async () => {
      isInteractive.mockReturnValue(true);

      await expect(
        collect({ issuer: ` ${issuer} `, audience: ` ${audience} ` }),
      ).resolves.toEqual({ issuer, audience });
      expect(input).not.toHaveBeenCalled();
    });

    it('asks for the issuer and the audience when interactive', async () => {
      isInteractive.mockReturnValue(true);
      input.mockResolvedValueOnce(issuer).mockResolvedValueOnce(audience);

      await expect(collect()).resolves.toEqual({ issuer, audience });
      expect(input).toHaveBeenNthCalledWith(1, {
        message:
          'Token issuer URL (the iss claim). Leave empty to add issuers later in application.yaml:',
      });
      expect(input).toHaveBeenNthCalledWith(2, {
        message: 'Audience that the aud claim must contain. Leave empty for no audience check:',
      });
    });

    it('does not ask for an audience when the issuer is empty', async () => {
      isInteractive.mockReturnValue(true);
      input.mockResolvedValueOnce('');

      await expect(collect()).resolves.toEqual(noOptions);
      expect(input).toHaveBeenCalledTimes(1);
    });

    it('refuses an audience with no issuer', async () => {
      await expect(collect({ audience })).rejects.toThrow(
        'The audience option needs an issuer',
      );
    });

    it.each(['issuer.example.org', 'ftp://issuer.example.org'])(
      'refuses the issuer %s',
      async (value) => {
        await expect(collect({ issuer: value })).rejects.toThrow(
          `Invalid issuer '${value}'`,
        );
      },
    );
  });

  describe('apply', () => {
    it('writes the Java files, the tests, and AUTH-RESOURCE.md', async () => {
      await authResourceFeature.apply(tree, serverProject(tree), noOptions);

      const written = [
        `${javaRoot}/auth/BearerTokenInterceptor.java`,
        `${javaRoot}/auth/AuthResourceProperties.java`,
        `${javaRoot}/auth/AuthResourceConfig.java`,
        `${javaTestRoot}/auth/BearerTokenInterceptorTest.java`,
        `${javaTestRoot}/auth/AuthResourceIT.java`,
        `${javaTestRoot}/auth/AuthResourceDefaultStateIT.java`,
        docPath,
      ];
      for (const file of written) {
        const content = tree.read(file, 'utf-8');
        expect(content, `${file} should exist`).not.toBeNull();
        expect(content).not.toContain('<%');
      }
      expect(tree.children(`${javaRoot}/auth`)).toHaveLength(3);
      expect(tree.children(`${javaTestRoot}/auth`)).toHaveLength(3);
      expect(
        tree.read(`${javaRoot}/auth/BearerTokenInterceptor.java`, 'utf-8'),
      ).toContain('package com.example.auth;');
      expect(
        tree.read(`${javaTestRoot}/auth/AuthResourceIT.java`, 'utf-8'),
      ).toContain('import ca.uhn.fhir.jpa.starter.Application;');
    });

    it('runs the integration test under the test profile with the FHIR version of the server', async () => {
      await authResourceFeature.apply(
        tree,
        { ...serverProject(tree), fhirVersion: FhirVersion.R5 },
        noOptions,
      );

      const integrationTest = tree.read(
        `${javaTestRoot}/auth/AuthResourceIT.java`,
        'utf-8',
      );
      expect(integrationTest).toContain('@ActiveProfiles("test")');
      expect(integrationTest).toContain('"hapi.fhir.fhir_version=R5"');
    });

    it('writes the app.auth block with enabled: true, the issuer, and the bypass-header comment line', async () => {
      await authResourceFeature.apply(tree, serverProject(tree), {
        issuer,
        audience: '',
      });

      expect(tree.read(yamlPath, 'utf-8')).toBe(
        [
          'hapi:',
          '  fhir:',
          '    fhir_version: R4',
          'app:',
          '  auth:',
          '    enabled: true',
          '    issuers:',
          '      - issuer: https://issuer.example.org',
          '    public-endpoints: []',
          '    # bypass-header: X-Bypass-Auth',
          '',
        ].join('\n'),
      );
    });

    it('writes the app.auth block with enabled: false and no issuer when it gets no issuer', async () => {
      await authResourceFeature.apply(tree, serverProject(tree), noOptions);

      expect(tree.read(yamlPath, 'utf-8')).toBe(
        [
          'hapi:',
          '  fhir:',
          '    fhir_version: R4',
          'app:',
          '  auth:',
          '    enabled: false',
          '    issuers: []',
          '    public-endpoints: []',
          '    # bypass-header: X-Bypass-Auth',
          '',
        ].join('\n'),
      );
    });

    it('writes one issuers entry with the issuer and the audience', async () => {
      await authResourceFeature.apply(tree, serverProject(tree), {
        issuer,
        audience,
      });

      expect(readYaml(tree).app.auth.enabled).toBe(true);
      expect(readYaml(tree).app.auth.issuers).toEqual([{ issuer, audience }]);
    });

    it.each([
      ['with no app key', 'hapi:\n  fhir:\n    fhir_version: R4\n', {}],
      [
        'with app.proxy and app.fhir',
        'app:\n  proxy:\n    enabled: true\n  fhir:\n    servers: \'[{"name":"EHR","url":"http://ehr:8080/fhir"}]\'\nhapi:\n  fhir:\n    fhir_version: R4\n',
        {
          proxy: { enabled: true },
          fhir: { servers: '[{"name":"EHR","url":"http://ehr:8080/fhir"}]' },
        },
      ],
    ])(
      'writes empty lists and the comment line in a file %s',
      async (_, before, otherAppKeys) => {
        tree.write(yamlPath, before);

        await authResourceFeature.apply(tree, serverProject(tree), noOptions);

        const text = tree.read(yamlPath, 'utf-8') as string;
        const { app, hapi } = parseDocument(text).toJS();
        expect(hapi).toEqual({ fhir: { fhir_version: 'R4' } });
        expect(app).toEqual({
          ...otherAppKeys,
          auth: { enabled: false, issuers: [], 'public-endpoints': [] },
        });

        const lines = text.split('\n');
        const endpoints = lines.findIndex((line) =>
          /^\s*public-endpoints:/.test(line),
        );
        const indent = lines[endpoints].match(/^\s*/)?.[0];
        expect(lines[endpoints + 1]).toBe(
          `${indent}# bypass-header: X-Bypass-Auth`,
        );

        const enabled = text.replace(
          '# bypass-header: X-Bypass-Auth',
          'bypass-header: X-Bypass-Auth',
        );
        expect(parseDocument(enabled).errors).toEqual([]);
        expect(parseDocument(enabled).toJS().app.auth['bypass-header']).toBe(
          'X-Bypass-Auth',
        );
      },
    );

    it.each([testConfigPath, testProfilePath])(
      'creates %s with app.auth.enabled: false',
      async (file) => {
        await authResourceFeature.apply(tree, serverProject(tree), {
          issuer,
          audience: '',
        });

        expect(tree.read(file, 'utf-8')).toBe(
          'app:\n  auth:\n    enabled: false\n',
        );
      },
    );

    it.each([testConfigPath, testProfilePath])(
      'sets only app.auth.enabled in an existing %s',
      async (file) => {
        tree.write(
          file,
          '# Test settings\nhapi:\n  fhir:\n    fhir_version: R4 # starter value\napp:\n  auth:\n    enabled: true\n    issuers:\n      - issuer: https://other.example.org\n    public-endpoints:\n      - Patient\n',
        );

        await authResourceFeature.apply(tree, serverProject(tree), noOptions);

        expect(tree.read(file, 'utf-8')).toBe(
          '# Test settings\nhapi:\n  fhir:\n    fhir_version: R4 # starter value\napp:\n  auth:\n    enabled: false\n    issuers:\n      - issuer: https://other.example.org\n    public-endpoints:\n      - Patient\n',
        );
      },
    );

    it('does not change pom.xml', async () => {
      const pomBefore = tree.read(pomPath, 'utf-8');

      await authResourceFeature.apply(tree, serverProject(tree), {
        issuer,
        audience,
      });

      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
    });

    it('refuses to overwrite a file that is already there', async () => {
      tree.write(`${javaRoot}/auth/AuthResourceConfig.java`, 'hand written');
      tree.write(docPath, 'hand written');
      const yamlBefore = tree.read(yamlPath, 'utf-8');

      const result = authResourceFeature.apply(
        tree,
        serverProject(tree),
        noOptions,
      );

      await expect(result).rejects.toThrow(
        `${javaRoot}/auth/AuthResourceConfig.java`,
      );
      await expect(result).rejects.toThrow(docPath);
      expect(tree.read(yamlPath, 'utf-8')).toBe(yamlBefore);
      expect(tree.exists(testConfigPath)).toBe(false);
      expect(tree.exists(testProfilePath)).toBe(false);
      expect(
        tree.exists(`${javaRoot}/auth/BearerTokenInterceptor.java`),
      ).toBe(false);
      expect(tree.read(docPath, 'utf-8')).toBe('hand written');
    });

    it('writes no yaml file when a test configuration file does not parse', async () => {
      tree.write(testProfilePath, 'hapi: [\n');
      const yamlBefore = tree.read(yamlPath, 'utf-8');

      await expect(
        authResourceFeature.apply(tree, serverProject(tree), noOptions),
      ).rejects.toThrow();
      expect(tree.read(yamlPath, 'utf-8')).toBe(yamlBefore);
      expect(tree.exists(testConfigPath)).toBe(false);
      expect(tree.exists(`${javaRoot}/auth`)).toBe(false);
    });

    it('writes AUTH-RESOURCE.md with the properties, the warning, and the doc rules', async () => {
      await authResourceFeature.apply(tree, serverProject(tree), noOptions);

      const doc = tree.read(docPath, 'utf-8') as string;
      expect(doc).toContain(
        'src/main/java/com/example/auth/BearerTokenInterceptor.java',
      );
      for (const text of [
        'app.auth.enabled',
        'app.auth.issuers',
        'app.auth.public-endpoints',
        'app.auth.bypass-header',
        'BearerTokenInterceptor.CLAIMS_KEY',
        'The check applies to requests under `/fhir`.',
        'A public entry applies to each request method.',
        'A paging request passes with no token. A paging request has the parameter `_getpages`.',
      ]) {
        expect(doc).toContain(text);
      }
      expect(doc).toContain(
        'WARNING: With `app.auth.bypass-header` set, each caller that sends this header skips the token check. Remove the property for a deployment that has data that is not public.',
      );
      expect(doc).not.toMatch(/[;—]/);
      expect(doc).not.toMatch(/\b(now|previously|no longer)\b/i);
      expect(doc).not.toMatch(/\n\n\n/);
    });
  });

  describe('through runFeature', () => {
    it('records the feature and its options', async () => {
      await runFeature(
        tree,
        {
          feature: 'auth-resource',
          project: 'server',
          options: { issuer, audience },
        },
        [authResourceFeature],
      );

      expect(serverProject(tree).features).toEqual({
        'auth-resource': { version: 1, options: { issuer, audience } },
      });
      expect(
        tree.exists(`${javaRoot}/auth/BearerTokenInterceptor.java`),
      ).toBe(true);
    });

    it('rejects a server below HAPI 8.8.0', async () => {
      tree = createServerTree('8.6.0');

      await expect(
        runFeature(tree, { feature: 'auth-resource', project: 'server' }, [
          authResourceFeature,
        ]),
      ).rejects.toThrow(/8\.8\.0 and later/);
      expect(tree.exists(`${javaRoot}/auth`)).toBe(false);
      expect(tree.read(yamlPath, 'utf-8')).toBe(
        'hapi:\n  fhir:\n    fhir_version: R4\n',
      );
    });
  });
});
