import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  generateFiles,
  logger,
  readProjectConfiguration,
  removeProjectConfiguration,
} from '@nx/devkit';
import { readFileSync } from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';

import { AUTH_LOGIN_FEATURE, authLoginFeature } from './auth-login';
import { runFeature } from '../feature/run-feature';
import { updateServerYaml } from '../../shared/utils';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ confirm }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const serverRoot = 'test-project';
const javaRoot = `${serverRoot}/src/main/java/com/example`;
const javaTestRoot = `${serverRoot}/src/test/java/com/example`;
const configDir = `${javaRoot}/config`;
const yamlPath = `${serverRoot}/src/main/resources/application.yaml`;
const pomPath = `${serverRoot}/pom.xml`;
const docPath = `${serverRoot}/AUTH-LOGIN.md`;
const frontendTemplates = path.join(__dirname, '..', 'frontend', 'files');

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
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

function copyFrontendTemplate(tree: Tree, frontendRoot: string, file: string) {
  tree.write(
    `${frontendRoot}/${file}`,
    readFileSync(path.join(frontendTemplates, 'common', file), 'utf-8'),
  );
}

/** A frontend integrated with the server, with the sign-in support of the shipped template. */
function addFrontend(tree: Tree, name: string, integratedRoot = serverRoot) {
  addProjectConfiguration(tree, name, {
    root: name,
    projectType: 'application',
    targets: {
      'copy-to-server': {
        executor: 'nx:run-commands',
        options: {
          commands: [
            `rimraf --glob "../${integratedRoot}/src/main/resources/static/*"`,
            `cpy "dist/**" "../${integratedRoot}/src/main/resources/static" --cwd=.`,
          ],
        },
      },
    },
  });
  copyFrontendTemplate(tree, name, 'src/lib/fhir-config.ts');
  copyFrontendTemplate(tree, name, 'src/components/sign-in-section.tsx');
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
  // The server integration files of the frontend generator, from the shipped templates.
  generateFiles(tree, path.join(frontendTemplates, 'server'), javaRoot, {
    packageBase: 'com.example',
  });
  addFrontend(tree, 'frontend');
  return tree;
}

function serverProject(tree: Tree): ServerProjectConfiguration {
  return readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
}

function readYaml(tree: Tree) {
  return parseDocument(tree.read(yamlPath, 'utf-8') as string).toJS();
}

describe('auth-login feature', () => {
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

  describe('install check', () => {
    const collect = () =>
      authLoginFeature.collectOptions(tree, serverProject(tree), {});

    it('refuses a server with no integrated frontend', async () => {
      removeProjectConfiguration(tree, 'frontend');
      addFrontend(tree, 'other', 'other-server');

      await expect(collect()).rejects.toThrow(
        "Feature 'auth-login' found no frontend project that is integrated with project 'server'",
      );
    });

    it.each([
      [
        'no APP_REQUEST_HEADER export',
        'admin/src/lib/fhir-config.ts',
        'export function toRequestUrl() {}\n',
      ],
      ['no sign-in section', 'admin/src/components/sign-in-section.tsx', null],
    ])(
      'refuses a frontend with no APP_REQUEST_HEADER export or no sign-in section and names it: %s',
      async (_, file, content) => {
        addFrontend(tree, 'admin');
        if (content === null) {
          tree.delete(file);
        } else {
          tree.write(file, content);
        }

        const result = collect();
        await expect(result).rejects.toThrow(
          "Feature 'auth-login' cannot install: frontend project 'admin' has no sign-in support.",
        );
        await expect(result).rejects.toThrow(file);
        await expect(result).rejects.toThrow(
          'Run "nx g nx-fhir:update-frontend --project=admin" first.',
        );
      },
    );

    it('refuses when ConfigController.java does not read app.login', async () => {
      const file = `${configDir}/ConfigController.java`;
      tree.write(file, '@Value("${app.proxy.enabled:false}")\n');
      addFrontend(tree, 'admin');

      const result = collect();
      await expect(result).rejects.toThrow(file);
      await expect(result).rejects.toThrow(
        'Run "nx g nx-fhir:update-frontend --project=frontend" and "nx g nx-fhir:update-frontend --project=admin", then resolve each merge conflict in this file.',
      );
    });
  });

  describe('apply', () => {
    it('writes the Java files, the tests, and AUTH-LOGIN.md', async () => {
      await authLoginFeature.apply(tree, serverProject(tree), {});

      const written = [
        `${javaRoot}/login/IdTokenCheck.java`,
        `${javaRoot}/login/LoginClients.java`,
        `${javaRoot}/login/LoginController.java`,
        `${javaRoot}/login/LoginFilter.java`,
        `${javaRoot}/login/LoginSession.java`,
        `${javaTestRoot}/login/AuthLoginIT.java`,
        `${javaTestRoot}/login/LoginClientsTest.java`,
        `${javaTestRoot}/login/LoginControllerTest.java`,
        `${javaTestRoot}/login/LoginFilterTest.java`,
        docPath,
      ];
      for (const file of written) {
        const content = tree.read(file, 'utf-8');
        expect(content, `${file} should exist`).not.toBeNull();
        expect(content).not.toContain('<%');
      }
      expect(tree.children(`${javaRoot}/login`)).toHaveLength(5);
      expect(tree.children(`${javaTestRoot}/login`)).toHaveLength(4);
      expect(
        tree.read(`${javaRoot}/login/LoginController.java`, 'utf-8'),
      ).toContain('package com.example.login;');
    });

    it('renders the integration test with the test profile, the FHIR version, and the application class of the server', async () => {
      tree.write(
        `${serverRoot}/src/main/java/org/acme/AcmeServer.java`,
        'package org.acme;\n\n@SpringBootApplication\npublic class AcmeServer {}\n',
      );

      await authLoginFeature.apply(
        tree,
        { ...serverProject(tree), fhirVersion: FhirVersion.R5 },
        {},
      );

      const integrationTest = tree.read(
        `${javaTestRoot}/login/AuthLoginIT.java`,
        'utf-8',
      );
      expect(integrationTest).toContain('import org.acme.AcmeServer;');
      expect(integrationTest).toContain('classes = {AcmeServer.class}');
      expect(integrationTest).toContain('@ActiveProfiles("test")');
      expect(integrationTest).toContain('"hapi.fhir.fhir_version=R5"');
    });

    it('adds oauth2-oidc-sdk 11.26 to the pom one time', async () => {
      await authLoginFeature.apply(tree, serverProject(tree), {});

      const pom = tree.read(pomPath, 'utf-8') as string;
      const inserted = pom
        .match(/<dependency>(?:(?!<\/dependency>)[\s\S])*<\/dependency>/g)
        ?.filter((element) =>
          element.includes('<artifactId>oauth2-oidc-sdk</artifactId>'),
        );
      expect(inserted).toHaveLength(1);
      expect(inserted?.[0]).toContain('<groupId>com.nimbusds</groupId>');
      expect(inserted?.[0]).toContain('<version>11.26</version>');
      expect(pom.indexOf('oauth2-oidc-sdk')).toBeLessThan(
        pom.indexOf('<build>'),
      );
    });

    it('writes the login and session keys and keeps every other line of application.yaml', async () => {
      tree.write(
        yamlPath,
        [
          '# Settings of the HAPI starter',
          'hapi:',
          '  fhir:',
          '    fhir_version: R4',
          'server:',
          '  # The port of the server',
          '  port: 8080',
          '',
        ].join('\n'),
      );
      updateServerYaml(serverRoot, tree, 'server.port', 8080);
      const before = tree.read(yamlPath, 'utf-8') as string;

      await authLoginFeature.apply(tree, serverProject(tree), {});

      expect(tree.read(yamlPath, 'utf-8')).toBe(
        before +
          [
            '  servlet:',
            '    session:',
            '      cookie:',
            '        same-site: lax',
            '      tracking-modes: cookie',
            'app:',
            '  login:',
            '    enabled: true',
            '    ssl-verify: true',
            '',
          ].join('\n'),
      );
      expect(readYaml(tree)).toEqual({
        hapi: { fhir: { fhir_version: 'R4' } },
        server: {
          port: 8080,
          servlet: {
            session: { cookie: { 'same-site': 'lax' }, 'tracking-modes': 'cookie' },
          },
        },
        app: { login: { enabled: true, 'ssl-verify': true } },
      });
    });

    it('refuses to overwrite a file that is already there', async () => {
      tree.write(`${javaRoot}/login/LoginFilter.java`, 'hand written');
      tree.write(docPath, 'hand written');
      const pomBefore = tree.read(pomPath, 'utf-8');
      const yamlBefore = tree.read(yamlPath, 'utf-8');

      const result = authLoginFeature.apply(tree, serverProject(tree), {});

      await expect(result).rejects.toThrow(
        `${javaRoot}/login/LoginFilter.java`,
      );
      await expect(result).rejects.toThrow(docPath);
      expect(tree.children(`${javaRoot}/login`)).toEqual(['LoginFilter.java']);
      expect(tree.exists(`${javaTestRoot}/login`)).toBe(false);
      expect(tree.read(`${javaRoot}/login/LoginFilter.java`, 'utf-8')).toBe(
        'hand written',
      );
      expect(tree.read(docPath, 'utf-8')).toBe('hand written');
      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
      expect(tree.read(yamlPath, 'utf-8')).toBe(yamlBefore);
    });

    it('puts back the pom when the yaml edit refuses', async () => {
      tree.delete(yamlPath);
      const pomBefore = tree.read(pomPath, 'utf-8');

      await expect(
        authLoginFeature.apply(tree, serverProject(tree), {}),
      ).rejects.toThrow('Configuration file not found');
      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
      expect(tree.exists(`${javaRoot}/login`)).toBe(false);
      expect(tree.exists(docPath)).toBe(false);
    });

    it('puts back the pom and the yaml when a later yaml edit refuses', async () => {
      // A servlet key with only commented children has a null value, so the third edit,
      // server.servlet.session.cookie.same-site, refuses after the two app.login keys are written.
      tree.write(
        yamlPath,
        'hapi:\n  fhir:\n    fhir_version: R4\nserver:\n  servlet:\n    # context-path: /example\n  port: 8080\n',
      );
      const pomBefore = tree.read(pomPath, 'utf-8');
      const yamlBefore = tree.read(yamlPath, 'utf-8');

      await expect(
        authLoginFeature.apply(tree, serverProject(tree), {}),
      ).rejects.toThrow('Expected YAML collection');
      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
      expect(tree.read(yamlPath, 'utf-8')).toBe(yamlBefore);
      expect(tree.exists(`${javaRoot}/login`)).toBe(false);
      expect(tree.exists(docPath)).toBe(false);
    });

    it('writes AUTH-LOGIN.md with the keys and the warnings and no em-dash', async () => {
      await authLoginFeature.apply(tree, serverProject(tree), {});

      const doc = tree.read(docPath, 'utf-8') as string;
      expect(doc).toContain(
        '`LoginSession` under `src/main/java/com/example/login/`',
      );
      for (const key of [
        'app.login.enabled',
        'app.login.ssl-verify',
        'server.servlet.session.cookie.same-site',
        'server.servlet.session.tracking-modes',
        'app.proxy.passthrough',
        'app.proxy.connect-timeout',
        'app.proxy.read-timeout',
        'server.forward-headers-strategy',
        'hapi.fhir.cors.allowed_headers',
        'GlobalCorsConfiguration',
        'X-App-Request',
        'Sec-Fetch-Site',
        '/auth/callback',
        'DEV_SERVER_URL',
      ]) {
        expect(doc).toContain(key);
      }
      expect(doc).toMatch(
        /WARNING: .*`X-App-Request` or `\*`.*`hapi\.fhir\.cors\.allowed_headers`/,
      );
      expect(doc).toMatch(/WARNING: On plain `http`/);
      expect(doc).toMatch(/WARNING: With `app\.login\.ssl-verify: false`/);
      expect(doc).not.toMatch(/[;—]/);
      expect(doc).not.toMatch(/\b(now|previously|no longer|new|again)\b/i);
      expect(doc).not.toMatch(/\n\n\n/);
    });
  });

  describe('through runFeature', () => {
    it('installs frontend-proxy first and records auth-login with no options', async () => {
      await runFeature(tree, { feature: AUTH_LOGIN_FEATURE, project: 'server' });

      const features = serverProject(tree).features;
      expect(Object.keys(features ?? {})).toEqual([
        'frontend-proxy',
        'auth-login',
      ]);
      expect(features?.['auth-login']).toEqual({ version: 1, options: {} });
      expect(confirm).not.toHaveBeenCalled();
      expect(
        tree.exists(`${javaRoot}/proxy/FrontendProxyController.java`),
      ).toBe(true);
      expect(tree.exists(`${javaRoot}/login/LoginController.java`)).toBe(true);
    });

    it('rejects a server below HAPI 8.8.0', async () => {
      tree = createServerTree('8.6.0');

      await expect(
        runFeature(tree, { feature: AUTH_LOGIN_FEATURE, project: 'server' }),
      ).rejects.toThrow(/'auth-login' supports HAPI FHIR 8\.8\.0 and later/);
      expect(tree.exists(`${javaRoot}/proxy`)).toBe(false);
      expect(tree.exists(`${javaRoot}/login`)).toBe(false);
      expect(serverProject(tree).features).toBeUndefined();
    });
  });
});
