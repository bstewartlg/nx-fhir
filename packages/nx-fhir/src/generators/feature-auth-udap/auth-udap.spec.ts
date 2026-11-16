import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';
import { parseDocument } from 'yaml';

import { authUdapFeature } from './auth-udap';
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
const gitignorePath = `${serverRoot}/.gitignore`;
const docPath = `${serverRoot}/AUTH-UDAP.md`;
const starterYaml = 'hapi:\n  fhir:\n    fhir_version: R4\n';
const authResourceYaml = `${starterYaml}app:\n  auth:\n    enabled: true\n    issuer: ${DEFAULT_ISSUER}\n`;
const certFile = '/certs/server.pfx';
const certFilePrompt =
  'Path of a PKCS#12 certificate file. Leave empty and the server fetches a test certificate from the issuer:';
const defaultOptions = { certFile: '' };

const udapLists = {
  'profiles-supported': ['udap_dcr', 'udap_authn', 'udap_authz', 'udap_to'],
  'grant-types-supported': [
    'authorization_code',
    'refresh_token',
    'client_credentials',
  ],
  'authorization-extensions-supported': ['hl7-b2b'],
  'authorization-extensions-required': [],
  'certifications-supported': [],
  'token-endpoint-auth-signing-alg-values-supported': [
    'RS256',
    'RS384',
    'ES256',
    'ES384',
  ],
  'registration-endpoint-jwt-signing-alg-values-supported': [
    'RS256',
    'RS384',
    'ES256',
    'ES384',
  ],
};

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

describe('auth-udap feature', () => {
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
      authUdapFeature.collectOptions(tree, serverProject(tree), provided);

    it('takes a provided certFile without a prompt and trims it', async () => {
      isInteractive.mockReturnValue(true);

      await expect(collect({ certFile: ` ${certFile} ` })).resolves.toEqual({
        certFile,
      });
      expect(input).not.toHaveBeenCalled();
    });

    it.each([
      ['interactive', true, certFile],
      ['not interactive', false, ''],
    ])(
      'asks for the certificate file only when interactive (%s)',
      async (_, interactive, expected) => {
        isInteractive.mockReturnValue(interactive);
        input.mockResolvedValueOnce(` ${certFile} `);

        await expect(collect()).resolves.toEqual({ certFile: expected });
        expect(input.mock.calls).toEqual(
          interactive ? [[{ message: certFilePrompt }]] : [],
        );
      },
    );
  });

  describe('apply', () => {
    it('writes the Java files, the tests, and AUTH-UDAP.md', async () => {
      await authUdapFeature.apply(
        tree,
        { ...serverProject(tree), fhirVersion: FhirVersion.R5 },
        defaultOptions,
      );

      const main = [
        'UdapCertificate',
        'UdapCertificateFetcher',
        'UdapConfig',
        'UdapMetadata',
        'UdapMetadataInterceptor',
        'UdapProperties',
      ];
      const tests = [
        'AuthUdapIT',
        'UdapCertificateFetcherTest',
        'UdapConfigTest',
        'UdapMetadataTest',
      ];
      const written = [
        ...main.map((name) => `${javaRoot}/udap/${name}.java`),
        ...tests.map((name) => `${javaTestRoot}/udap/${name}.java`),
        docPath,
      ];
      for (const file of written) {
        const content = tree.read(file, 'utf-8');
        expect(content, `${file} should exist`).not.toBeNull();
        expect(content).not.toContain('<%');
      }
      expect(tree.children(`${javaRoot}/udap`)).toHaveLength(main.length);
      expect(tree.children(`${javaTestRoot}/udap`)).toHaveLength(tests.length);
      const integrationTest = tree.read(
        `${javaTestRoot}/udap/AuthUdapIT.java`,
        'utf-8',
      );
      expect(integrationTest).toContain('@ActiveProfiles("test")');
      expect(integrationTest).toContain('"hapi.fhir.fhir_version=R5"');
    });

    it.each([
      ['no certFile gives fetch-cert', '', ['fetch-cert', true]],
      ['a certFile gives cert-file', certFile, ['cert-file', certFile]],
    ])('writes the udap map: %s', async (_, value, certificateSource) => {
      await authUdapFeature.apply(tree, serverProject(tree), {
        certFile: value,
      });

      expect(Object.entries(readYaml(tree).app.auth.udap)).toEqual([
        ['enabled', true],
        certificateSource,
        ...Object.entries(udapLists),
      ]);
    });

    it('installs auth-resource with its defaults when not interactive', async () => {
      tree = createServerTree(false);
      tree.write(gitignorePath, 'target/');

      await runFeature(tree, { feature: 'auth-udap', project: 'server' });

      const text = tree.read(yamlPath, 'utf-8') as string;
      expect(text).toBe(
        [
          'hapi:',
          '  fhir:',
          '    fhir_version: R4',
          'app:',
          '  auth:',
          '    enabled: true',
          '    issuer: https://udap-security.fast.hl7.org',
          '    public-endpoints: []',
          '    ssl-verify: true',
          '    # bypass-header: X-Bypass-Auth',
          '    udap:',
          '      enabled: true',
          '      fetch-cert: true',
          '      profiles-supported:',
          '        - udap_dcr',
          '        - udap_authn',
          '        - udap_authz',
          '        - udap_to',
          '      grant-types-supported:',
          '        - authorization_code',
          '        - refresh_token',
          '        - client_credentials',
          '      authorization-extensions-supported:',
          '        - hl7-b2b',
          '      authorization-extensions-required: []',
          '      certifications-supported: []',
          '      token-endpoint-auth-signing-alg-values-supported:',
          '        - RS256',
          '        - RS384',
          '        - ES256',
          '        - ES384',
          '      registration-endpoint-jwt-signing-alg-values-supported:',
          '        - RS256',
          '        - RS384',
          '        - ES256',
          '        - ES384',
          '',
        ].join('\n'),
      );
      const bypassOn = parseDocument(
        text.replace('# bypass-header:', 'bypass-header:'),
      );
      expect(bypassOn.errors).toEqual([]);
      const { auth } = bypassOn.toJS().app;
      expect(auth['bypass-header']).toBe('X-Bypass-Auth');
      expect(auth.udap).toEqual({
        enabled: true,
        'fetch-cert': true,
        ...udapLists,
      });

      for (const file of [testConfigPath, testProfilePath]) {
        expect(readYaml(tree, file).app.auth).toEqual({
          enabled: false,
          udap: { enabled: false },
        });
      }
      expect(tree.read(gitignorePath, 'utf-8')).toBe(
        'target/\ngenerated-cert.pfx\n',
      );
      expect(Object.keys(serverProject(tree).features ?? {})).toEqual([
        'auth-resource',
        'auth-udap',
      ]);
      expect(confirm).not.toHaveBeenCalled();
    });

    it('refusesWhenAFileExists', async () => {
      tree.write(`${javaRoot}/udap/UdapConfig.java`, 'hand written');
      tree.write(docPath, 'hand written');
      const before = treeState(tree);

      const result = authUdapFeature.apply(
        tree,
        serverProject(tree),
        defaultOptions,
      );

      await expect(result).rejects.toThrow(`${javaRoot}/udap/UdapConfig.java`);
      await expect(result).rejects.toThrow(docPath);
      expect(treeState(tree)).toEqual(before);
    });
  });
});
