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

import {
  FRONTEND_PROXY_FEATURE,
  frontendProxyFeature,
  writeDevServerEnv,
} from './frontend-proxy';
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
const docPath = `${serverRoot}/FRONTEND-PROXY.md`;
const frontendTemplates = path.join(__dirname, '..', 'frontend', 'files');
const devServerLine = 'DEV_SERVER_URL=http://localhost:8080';

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

/** A frontend integrated with the server, as the frontend generator writes it. */
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
  tree.write(
    `${name}/src/lib/fhir-config.ts`,
    readFileSync(
      path.join(frontendTemplates, 'common', 'src', 'lib', 'fhir-config.ts'),
      'utf-8',
    ),
  );
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

describe('frontend-proxy feature', () => {
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

  describe('install guard', () => {
    const collect = () =>
      frontendProxyFeature.collectOptions(tree, serverProject(tree), {});

    it('refuses a server with no integrated frontend', async () => {
      removeProjectConfiguration(tree, 'frontend');
      addFrontend(tree, 'other', 'other-server');

      await expect(collect()).rejects.toThrow(
        "found no frontend project that is integrated with project 'server'",
      );
    });

    it.each([
      ['has no toRequestUrl export', 'export function otherName() {}\n'],
      ['is absent', null],
    ])(
      'refuses when fhir-config.ts %s and names update-frontend',
      async (_, content) => {
        const file = 'frontend/src/lib/fhir-config.ts';
        if (content === null) {
          tree.delete(file);
        } else {
          tree.write(file, content);
        }

        await expect(collect()).rejects.toThrow(
          "frontend project 'frontend' has no proxy support",
        );
        await expect(collect()).rejects.toThrow(
          'nx g nx-fhir:update-frontend --project=frontend',
        );
      },
    );

    it('checks each integrated frontend and names the one that fails', async () => {
      addFrontend(tree, 'admin');
      tree.write('admin/src/lib/fhir-config.ts', 'export const other = 1;\n');

      await expect(collect()).rejects.toThrow(
        "frontend project 'admin' has no proxy support",
      );
    });

    it.each([
      ['is absent', null],
      ['has no app.proxy', 'public class ConfigController {}\n'],
    ])('refuses when ConfigController.java %s', async (_, content) => {
      const file = `${configDir}/ConfigController.java`;
      if (content === null) {
        tree.delete(file);
      } else {
        tree.write(file, content);
      }

      const result = collect();
      await expect(result).rejects.toThrow(
        'ConfigController.java is absent or does not read app.proxy',
      );
      await expect(result).rejects.toThrow(
        'nx g nx-fhir:update-frontend --project=frontend',
      );
      await expect(result).rejects.not.toThrow('FhirServers.java');
    });

    it('refuses when FhirServers.java is absent', async () => {
      tree.delete(`${configDir}/FhirServers.java`);

      await expect(collect()).rejects.toThrow('FhirServers.java is absent');
    });

    it('refuses when GlobalCorsConfiguration.java is present and has no "/proxy" mapping', async () => {
      const file = `${configDir}/GlobalCorsConfiguration.java`;
      tree.write(
        file,
        (tree.read(file, 'utf-8') as string).replace(
          'registry.addMapping("/proxy").allowedOrigins();',
          '',
        ),
      );

      await expect(collect()).rejects.toThrow(
        'GlobalCorsConfiguration.java has no mapping for /proxy',
      );
    });

    it('refuses when GlobalCorsConfiguration.java registers "/proxy" after "/**"', async () => {
      const file = `${configDir}/GlobalCorsConfiguration.java`;
      const proxyLine = 'registry.addMapping("/proxy").allowedOrigins();';
      const allPathsLine = 'var corsConfig = registry.addMapping("/**");';
      const cors = tree.read(file, 'utf-8') as string;
      expect(cors).toContain(allPathsLine);
      tree.write(
        file,
        cors
          .replace(proxyLine, '')
          .replace(allPathsLine, `${allPathsLine}\n    ${proxyLine}`),
      );

      await expect(collect()).rejects.toThrow(
        'GlobalCorsConfiguration.java registers /proxy after /**',
      );
    });

    it('accepts a "/proxy" mapping when there is no "/**" mapping', async () => {
      const file = `${configDir}/GlobalCorsConfiguration.java`;
      tree.write(
        file,
        (tree.read(file, 'utf-8') as string).replace(
          'registry.addMapping("/**")',
          'registry.addMapping("/api/**")',
        ),
      );

      await expect(collect()).resolves.toEqual({ passthrough: false });
    });

    it('accepts a server with no GlobalCorsConfiguration.java', async () => {
      tree.delete(`${configDir}/GlobalCorsConfiguration.java`);

      await expect(collect()).resolves.toEqual({ passthrough: false });
    });

    it('throws before it prompts', async () => {
      isInteractive.mockReturnValue(true);
      tree.delete(`${configDir}/FhirServers.java`);

      await expect(collect()).rejects.toThrow('FhirServers.java is absent');
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe('collectOptions', () => {
    it('defaults passthrough to false when not interactive', async () => {
      await expect(
        frontendProxyFeature.collectOptions(tree, serverProject(tree), {}),
      ).resolves.toEqual({ passthrough: false });
      expect(confirm).not.toHaveBeenCalled();
    });

    it('asks when interactive', async () => {
      isInteractive.mockReturnValue(true);
      confirm.mockResolvedValue(true);

      await expect(
        frontendProxyFeature.collectOptions(tree, serverProject(tree), {}),
      ).resolves.toEqual({ passthrough: true });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith({
        message: 'Permit requests to any public server that the user enters?',
        default: false,
      });
    });

    it('parses a provided string', async () => {
      isInteractive.mockReturnValue(true);

      await expect(
        frontendProxyFeature.collectOptions(tree, serverProject(tree), {
          passthrough: 'TRUE',
        }),
      ).resolves.toEqual({ passthrough: true });
      await expect(
        frontendProxyFeature.collectOptions(tree, serverProject(tree), {
          passthrough: 'yes',
        }),
      ).rejects.toThrow("Invalid passthrough 'yes'");
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe('apply', () => {
    it('writes the Java files, the tests, and FRONTEND-PROXY.md', async () => {
      await frontendProxyFeature.apply(tree, serverProject(tree), {
        passthrough: false,
      });

      const written = [
        `${javaRoot}/proxy/FrontendProxyController.java`,
        `${javaRoot}/proxy/ProxyHttpClients.java`,
        `${javaRoot}/proxy/ProxyDestinations.java`,
        `${javaRoot}/proxy/PublicAddresses.java`,
        `${javaTestRoot}/proxy/PublicAddressesTest.java`,
        `${javaTestRoot}/proxy/ProxyDestinationsTest.java`,
        `${javaTestRoot}/proxy/FrontendProxyControllerTest.java`,
        `${javaTestRoot}/proxy/FhirServersTest.java`,
        `${javaTestRoot}/proxy/FrontendProxyControllerIT.java`,
        docPath,
      ];
      for (const file of written) {
        const content = tree.read(file, 'utf-8');
        expect(content, `${file} should exist`).not.toBeNull();
        expect(content).not.toContain('<%');
      }
      expect(tree.children(`${javaRoot}/proxy`)).toHaveLength(4);
      expect(tree.children(`${javaTestRoot}/proxy`)).toHaveLength(5);
      expect(
        tree.read(`${javaRoot}/proxy/FrontendProxyController.java`, 'utf-8'),
      ).toContain('package com.example.proxy;');

      const integrationTest = tree.read(
        `${javaTestRoot}/proxy/FrontendProxyControllerIT.java`,
        'utf-8',
      );
      expect(integrationTest).toContain(
        'import ca.uhn.fhir.jpa.starter.Application;',
      );
      expect(integrationTest).toContain('classes = {Application.class}');
    });

    it('renders the application class that the server declares', async () => {
      tree.write(
        `${serverRoot}/src/main/java/org/acme/AcmeServer.java`,
        'package org.acme;\n\n@SpringBootApplication\npublic class AcmeServer {}\n',
      );

      await frontendProxyFeature.apply(tree, serverProject(tree), {
        passthrough: false,
      });

      const integrationTest = tree.read(
        `${javaTestRoot}/proxy/FrontendProxyControllerIT.java`,
        'utf-8',
      );
      expect(integrationTest).toContain('import org.acme.AcmeServer;');
      expect(integrationTest).toContain('classes = {AcmeServer.class}');
    });

    it('runs the integration test under the test profile with the FHIR version of the server', async () => {
      await frontendProxyFeature.apply(
        tree,
        { ...serverProject(tree), fhirVersion: FhirVersion.R5 },
        { passthrough: false },
      );

      const integrationTest = tree.read(
        `${javaTestRoot}/proxy/FrontendProxyControllerIT.java`,
        'utf-8',
      );
      expect(integrationTest).toContain(
        'import org.springframework.test.context.ActiveProfiles;',
      );
      expect(integrationTest).toContain('@ActiveProfiles("test")');
      expect(integrationTest).toContain('"hapi.fhir.fhir_version=R5"');
    });

    it('writes FRONTEND-PROXY.md with the keys, the warnings, and the doc rules', async () => {
      await frontendProxyFeature.apply(tree, serverProject(tree), {
        passthrough: false,
      });

      const doc = tree.read(docPath, 'utf-8') as string;
      expect(doc).toContain(
        '`PublicAddresses` under `src/main/java/com/example/proxy/`',
      );
      for (const key of [
        'app.proxy.enabled',
        'app.proxy.passthrough',
        'app.proxy.connect-timeout',
        'app.proxy.read-timeout',
        'app.fhir.servers',
        'server.forward-headers-strategy',
        'spring.http.client.factory=jdk',
        'DEV_SERVER_URL',
      ]) {
        expect(doc).toContain(key);
      }
      expect(doc).toContain(
        'WARNING: With `app.proxy.passthrough: true`, anyone who can reach the application can send requests through it to any public host. Use this only for a test deployment.',
      );
      expect(doc).toContain('hapi_server');
      expect(doc).not.toMatch(/[;—]/);
      expect(doc).not.toMatch(/\b(now|previously|no longer)\b/i);
      expect(doc).not.toMatch(/\n\n\n/);
    });

    it('adds httpclient5 to the pom with no version', async () => {
      await frontendProxyFeature.apply(tree, serverProject(tree), {
        passthrough: false,
      });

      const pom = tree.read(pomPath, 'utf-8') as string;
      const inserted = pom
        .match(/<dependency>(?:(?!<\/dependency>)[\s\S])*<\/dependency>/g)
        ?.find((element) =>
          element.includes('<artifactId>httpclient5</artifactId>'),
        );
      expect(inserted).toContain(
        '<groupId>org.apache.httpcomponents.client5</groupId>',
      );
      expect(inserted).not.toContain('<version>');
      expect(pom.indexOf('httpclient5')).toBeLessThan(pom.indexOf('<build>'));
    });

    it.each([true, false])(
      'writes app.proxy.enabled true and the passthrough value %s',
      async (passthrough) => {
        await frontendProxyFeature.apply(tree, serverProject(tree), {
          passthrough,
        });

        expect(readYaml(tree).app).toEqual({
          proxy: { enabled: true, passthrough },
        });
        expect(readYaml(tree).server).toEqual({
          'forward-headers-strategy': 'native',
        });
      },
    );

    it('keeps every other line of application.yaml', async () => {
      tree.write(
        yamlPath,
        [
          '# Settings of the HAPI starter',
          'spring:',
          '  main:',
          '    allow-bean-definition-overriding: true',
          'hapi:',
          '  fhir:',
          '    # The FHIR version of the server',
          '    fhir_version: R4',
          '    cors:',
          '      allow_Credentials: true',
          '',
        ].join('\n'),
      );
      updateServerYaml(serverRoot, tree, 'hapi.fhir.fhir_version', 'R4');
      const before = tree.read(yamlPath, 'utf-8') as string;

      await frontendProxyFeature.apply(tree, serverProject(tree), {
        passthrough: false,
      });

      expect(tree.read(yamlPath, 'utf-8')).toBe(
        `${before}app:\n  proxy:\n    enabled: true\n    passthrough: false\nserver:\n  forward-headers-strategy: native\n`,
      );
    });

    it('puts the keys into an app block that is already there', async () => {
      const servers = '[{"name":"EHR","url":"http://ehr:8080/fhir"}]';
      tree.write(
        yamlPath,
        `hapi:\n  fhir:\n    fhir_version: R4\napp:\n  fhir:\n    servers: '${servers}'\n`,
      );

      await frontendProxyFeature.apply(tree, serverProject(tree), {
        passthrough: true,
      });

      const text = tree.read(yamlPath, 'utf-8') as string;
      expect(text.match(/^app:/gm)).toHaveLength(1);
      expect(readYaml(tree).app).toEqual({
        fhir: { servers },
        proxy: { enabled: true, passthrough: true },
      });
    });

    it('adds DEV_SERVER_URL to .env.development of each integrated frontend one time', async () => {
      addFrontend(tree, 'admin');
      tree.write('admin/.env.development', 'VITE_TITLE=Admin');
      addFrontend(tree, 'other', 'other-server');

      await frontendProxyFeature.apply(tree, serverProject(tree), {
        passthrough: false,
      });

      expect(tree.read('frontend/.env.development', 'utf-8')).toBe(
        `${devServerLine}\n`,
      );
      expect(tree.read('admin/.env.development', 'utf-8')).toBe(
        `VITE_TITLE=Admin\n${devServerLine}\n`,
      );
      expect(tree.exists('other/.env.development')).toBe(false);
    });

    it('refuses to overwrite a file that is already there', async () => {
      tree.write(`${javaRoot}/proxy/PublicAddresses.java`, 'hand written');
      tree.write(docPath, 'hand written');
      const pomBefore = tree.read(pomPath, 'utf-8');
      const yamlBefore = tree.read(yamlPath, 'utf-8');

      const result = frontendProxyFeature.apply(tree, serverProject(tree), {
        passthrough: false,
      });

      await expect(result).rejects.toThrow(
        `${javaRoot}/proxy/PublicAddresses.java`,
      );
      await expect(result).rejects.toThrow(docPath);
      expect(
        tree.exists(`${javaRoot}/proxy/FrontendProxyController.java`),
      ).toBe(false);
      expect(tree.read(`${javaRoot}/proxy/PublicAddresses.java`, 'utf-8')).toBe(
        'hand written',
      );
      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
      expect(tree.read(yamlPath, 'utf-8')).toBe(yamlBefore);
      expect(tree.exists('frontend/.env.development')).toBe(false);
    });

    it('writes nothing when the pom has no project <dependencies> block', async () => {
      const pom = starterPom('8.12.0').replace(
        /\s*<dependencies>[\s\S]*?<\/dependencies>/,
        '',
      );
      tree.write(pomPath, pom);
      const yamlBefore = tree.read(yamlPath, 'utf-8');

      await expect(
        runFeature(
          tree,
          { feature: FRONTEND_PROXY_FEATURE, project: 'server' },
          [frontendProxyFeature],
        ),
      ).rejects.toThrow('there is no project <dependencies> element');
      expect(tree.exists(`${javaRoot}/proxy`)).toBe(false);
      expect(tree.exists(`${javaTestRoot}/proxy`)).toBe(false);
      expect(tree.exists(docPath)).toBe(false);
      expect(tree.read(pomPath, 'utf-8')).toBe(pom);
      expect(tree.read(yamlPath, 'utf-8')).toBe(yamlBefore);
      expect(tree.exists('frontend/.env.development')).toBe(false);
      expect(serverProject(tree).features).toBeUndefined();
    });

    it('puts back the pom when the yaml edit refuses', async () => {
      tree.delete(yamlPath);
      const pomBefore = tree.read(pomPath, 'utf-8');

      await expect(
        frontendProxyFeature.apply(tree, serverProject(tree), {
          passthrough: false,
        }),
      ).rejects.toThrow('Configuration file not found');
      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
      expect(tree.exists(`${javaRoot}/proxy`)).toBe(false);
      expect(tree.exists(docPath)).toBe(false);
      expect(tree.exists('frontend/.env.development')).toBe(false);
    });

    it('puts back the pom and the yaml when a later yaml edit refuses', async () => {
      // A server key with only a commented child has a null value, so the third edit,
      // server.forward-headers-strategy, refuses after the two app.proxy keys are written.
      tree.write(
        yamlPath,
        'hapi:\n  fhir:\n    fhir_version: R4\nserver:\n  # port: 8080\n',
      );
      const pomBefore = tree.read(pomPath, 'utf-8');
      const yamlBefore = tree.read(yamlPath, 'utf-8');

      await expect(
        frontendProxyFeature.apply(tree, serverProject(tree), {
          passthrough: false,
        }),
      ).rejects.toThrow('Expected YAML collection');
      expect(tree.read(pomPath, 'utf-8')).toBe(pomBefore);
      expect(tree.read(yamlPath, 'utf-8')).toBe(yamlBefore);
      expect(tree.exists(`${javaRoot}/proxy`)).toBe(false);
      expect(tree.exists(docPath)).toBe(false);
    });
  });

  describe('writeDevServerEnv', () => {
    const envPath = 'frontend/.env.development';

    it('makes the file when it is absent', () => {
      writeDevServerEnv(tree, 'frontend');

      expect(tree.read(envPath, 'utf-8')).toBe(`${devServerLine}\n`);
    });

    it('keeps each line of a file that ends with a newline', () => {
      tree.write(envPath, 'VITE_A=1\n# shared\nVITE_B=2\n');

      writeDevServerEnv(tree, 'frontend');

      expect(tree.read(envPath, 'utf-8')).toBe(
        `VITE_A=1\n# shared\nVITE_B=2\n${devServerLine}\n`,
      );
    });

    it('adds the missing newline before the line', () => {
      tree.write(envPath, 'VITE_A=1');

      writeDevServerEnv(tree, 'frontend');

      expect(tree.read(envPath, 'utf-8')).toBe(`VITE_A=1\n${devServerLine}\n`);
    });

    it('changes nothing when a line already starts with DEV_SERVER_URL=', () => {
      const content =
        'VITE_A=1\nDEV_SERVER_URL=http://localhost:9090\nVITE_B=2';
      tree.write(envPath, content);

      writeDevServerEnv(tree, 'frontend');

      expect(tree.read(envPath, 'utf-8')).toBe(content);
    });

    it('adds the line one time when it runs twice', () => {
      writeDevServerEnv(tree, 'frontend');
      writeDevServerEnv(tree, 'frontend');

      expect(tree.read(envPath, 'utf-8')).toBe(`${devServerLine}\n`);
    });
  });

  describe('through runFeature', () => {
    it('records the feature and its options', async () => {
      await runFeature(
        tree,
        { feature: FRONTEND_PROXY_FEATURE, project: 'server' },
        [frontendProxyFeature],
      );

      expect(serverProject(tree).features).toEqual({
        'frontend-proxy': { version: 1, options: { passthrough: false } },
      });
      expect(
        tree.exists(`${javaRoot}/proxy/FrontendProxyController.java`),
      ).toBe(true);
    });

    it('rejects a server below HAPI 8.8.0', async () => {
      tree = createServerTree('8.6.0');

      await expect(
        runFeature(
          tree,
          { feature: FRONTEND_PROXY_FEATURE, project: 'server' },
          [frontendProxyFeature],
        ),
      ).rejects.toThrow(/8\.8\.0 and later/);
      expect(
        tree.exists(`${javaRoot}/proxy/FrontendProxyController.java`),
      ).toBe(false);
    });
  });
});
