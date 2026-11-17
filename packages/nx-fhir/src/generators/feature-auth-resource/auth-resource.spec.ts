import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';

import {
  authResourceFeature,
  DEFAULT_ISSUER,
  LOCAL_FAST_ISSUER,
  OTHER_ISSUER,
} from './auth-resource';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const { input, select } = vi.hoisted(() => ({
  input: vi.fn(),
  select: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({ input, select }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const serverRoot = 'test-project';
const javaRoot = `${serverRoot}/src/main/java/com/example`;
const javaTestRoot = `${serverRoot}/src/test/java/com/example`;
const yamlPath = `${serverRoot}/src/main/resources/application.yaml`;
const testConfigPath = `${serverRoot}/src/test/resources/config/application.yaml`;
const testProfilePath = `${serverRoot}/src/test/resources/application-test.yaml`;
const docPath = `${serverRoot}/AUTH-RESOURCE.md`;
const starterYaml = 'hapi:\n  fhir:\n    fhir_version: R4\n';
const issuer = 'https://issuer.example.org';
const audience = 'https://fhir.example.org/fhir';
const defaultOptions = { issuer: DEFAULT_ISSUER, audience: '' };
const issuerPrompt = 'Token issuer URL:';
const audiencePrompt =
  'Audience that the aud claim must contain. Leave empty for no audience check:';

function createServerTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(yamlPath, starterYaml);
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

    it('uses the default issuer when not interactive', async () => {
      await expect(collect()).resolves.toEqual(defaultOptions);
      expect(select).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
    });

    it('takes provided values without a prompt and trims them', async () => {
      isInteractive.mockReturnValue(true);

      await expect(
        collect({ issuer: ` ${issuer} `, audience: ` ${audience} ` }),
      ).resolves.toEqual({ issuer, audience });
      expect(select).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
    });

    it.each([
      [DEFAULT_ISSUER, DEFAULT_ISSUER, [audiencePrompt]],
      [OTHER_ISSUER, issuer, [issuerPrompt, audiencePrompt]],
    ])(
      'asks for the issuer and the audience when interactive (answer %s)',
      async (answer, expectedIssuer, inputPrompts) => {
        isInteractive.mockReturnValue(true);
        select.mockResolvedValueOnce(answer);
        input.mockImplementation(async ({ message }) =>
          message === issuerPrompt ? issuer : audience,
        );

        await expect(collect()).resolves.toEqual({
          issuer: expectedIssuer,
          audience,
        });
        expect(select).toHaveBeenCalledTimes(1);
        const [{ choices, default: preselected }] = select.mock.calls[0];
        expect(choices.map(({ value }: { value: string }) => value)).toEqual([
          DEFAULT_ISSUER,
          LOCAL_FAST_ISSUER,
          OTHER_ISSUER,
        ]);
        expect(preselected).toBe(DEFAULT_ISSUER);
        expect(input.mock.calls.map(([{ message }]) => message)).toEqual(
          inputPrompts,
        );
      },
    );

    it.each(['issuer.example.org', 'ftp://issuer.example.org'])(
      'refuses an issuer that is not an absolute http or https URL (%s)',
      async (value) => {
        await expect(collect({ issuer: value })).rejects.toThrow(
          `Invalid issuer '${value}'. Use an absolute http or https URL.`,
        );
      },
    );
  });

  describe('apply', () => {
    it('writes the Java files, the tests, and AUTH-RESOURCE.md', async () => {
      await authResourceFeature.apply(
        tree,
        { ...serverProject(tree), fhirVersion: FhirVersion.R5 },
        defaultOptions,
      );

      const written = [
        `${javaRoot}/auth/AuthResourceConfig.java`,
        `${javaRoot}/auth/AuthResourceProperties.java`,
        `${javaRoot}/auth/BearerTokenInterceptor.java`,
        `${javaRoot}/auth/FhirBaseUrl.java`,
        `${javaRoot}/auth/IssuerMetadata.java`,
        `${javaRoot}/auth/TrustAllSslContext.java`,
        `${javaRoot}/auth/WellKnownInterceptor.java`,
        `${javaTestRoot}/auth/AuthResourceIT.java`,
        `${javaTestRoot}/auth/BearerTokenInterceptorTest.java`,
        `${javaTestRoot}/auth/FhirBaseUrlTest.java`,
        `${javaTestRoot}/auth/TestCertificates.java`,
        docPath,
      ];
      for (const file of written) {
        const content = tree.read(file, 'utf-8');
        expect(content, `${file} should exist`).not.toBeNull();
        expect(content).not.toContain('<%');
      }
      expect(tree.children(`${javaRoot}/auth`)).toHaveLength(7);
      expect(tree.children(`${javaTestRoot}/auth`)).toHaveLength(4);
      expect(
        tree.read(`${javaRoot}/auth/BearerTokenInterceptor.java`, 'utf-8'),
      ).toContain('package com.example.auth;');
      const integrationTest = tree.read(
        `${javaTestRoot}/auth/AuthResourceIT.java`,
        'utf-8',
      );
      expect(integrationTest).toContain(
        'import ca.uhn.fhir.jpa.starter.Application;',
      );
      expect(integrationTest).toContain('@ActiveProfiles("test")');
      expect(integrationTest).toContain('"hapi.fhir.fhir_version=R5"');
    });

    it.each([
      [
        'the default issuer on the starter yaml',
        starterYaml,
        defaultOptions,
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
          '',
        ],
      ],
      [
        'the local issuer with an audience next to app.proxy and app.fhir',
        'app:\n  proxy:\n    enabled: true\n  fhir:\n    servers: \'[{"name":"EHR","url":"http://ehr:8080/fhir"}]\'\nhapi:\n  fhir:\n    fhir_version: R4\n',
        { issuer: LOCAL_FAST_ISSUER, audience },
        [
          'app:',
          '  proxy:',
          '    enabled: true',
          '  fhir:',
          '    servers: \'[{"name":"EHR","url":"http://ehr:8080/fhir"}]\'',
          '  auth:',
          '    enabled: true',
          '    issuer: https://localhost:5001',
          '    audience: https://fhir.example.org/fhir',
          '    public-endpoints: []',
          '    ssl-verify: false',
          '    # bypass-header: X-Bypass-Auth',
          'hapi:',
          '  fhir:',
          '    fhir_version: R4',
          '',
        ],
      ],
      [
        'an https issuer whose host only starts with localhost',
        starterYaml,
        { issuer: 'https://localhost.example.org', audience: '' },
        [
          'hapi:',
          '  fhir:',
          '    fhir_version: R4',
          'app:',
          '  auth:',
          '    enabled: true',
          '    issuer: https://localhost.example.org',
          '    public-endpoints: []',
          '    ssl-verify: true',
          '    # bypass-header: X-Bypass-Auth',
          '',
        ],
      ],
    ])(
      'writes the app.auth block for %s',
      async (_, before, options, expectedLines) => {
        tree.write(yamlPath, before);

        await authResourceFeature.apply(tree, serverProject(tree), options);

        expect(tree.read(yamlPath, 'utf-8')).toBe(expectedLines.join('\n'));
      },
    );

    it.each([
      [
        testConfigPath,
        '# Test settings\nhapi:\n  fhir:\n    fhir_version: R4 # starter value\napp:\n  auth:\n    enabled: true\n    issuer: https://other.example.org\n    public-endpoints:\n      - Patient\n',
        '# Test settings\nhapi:\n  fhir:\n    fhir_version: R4 # starter value\napp:\n  auth:\n    enabled: false\n    issuer: https://other.example.org\n    public-endpoints:\n      - Patient\n',
      ],
      [testProfilePath, null, 'app:\n  auth:\n    enabled: false\n'],
    ])(
      'writes app.auth.enabled: false to each test configuration file (%s)',
      async (file, before, expected) => {
        if (before !== null) {
          tree.write(file, before);
        }

        await authResourceFeature.apply(
          tree,
          serverProject(tree),
          defaultOptions,
        );

        expect(tree.read(file, 'utf-8')).toBe(expected);
      },
    );

    it.each([
      [
        'a template output exists',
        (tree: Tree) => {
          tree.write(`${javaRoot}/auth/AuthResourceConfig.java`, 'hand written');
          tree.write(docPath, 'hand written');
        },
        [`${javaRoot}/auth/AuthResourceConfig.java`, docPath],
      ],
      [
        'a test configuration file does not parse',
        (tree: Tree) => tree.write(testProfilePath, 'hapi: [\n'),
        [`Invalid YAML in ${testProfilePath}`],
      ],
      [
        'the main yaml is absent',
        (tree: Tree) => tree.delete(yamlPath),
        [`Configuration file not found at ${yamlPath}`],
      ],
    ])('refuses with no write when %s', async (_, arrange, messages) => {
      arrange(tree);
      const watched = [yamlPath, testConfigPath, testProfilePath, docPath];
      const before = watched.map((file) => tree.read(file, 'utf-8'));

      const result = authResourceFeature.apply(
        tree,
        serverProject(tree),
        defaultOptions,
      );

      for (const message of messages) {
        await expect(result).rejects.toThrow(message);
      }
      expect(watched.map((file) => tree.read(file, 'utf-8'))).toEqual(before);
      expect(
        tree.exists(`${javaRoot}/auth/BearerTokenInterceptor.java`),
      ).toBe(false);
      expect(tree.exists(`${javaTestRoot}/auth`)).toBe(false);
    });
  });
});
