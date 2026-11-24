import { vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  detectPackageManager,
  logger,
  readProjectConfiguration,
  readJson,
  removeProjectConfiguration,
  updateProjectConfiguration,
} from '@nx/devkit';
import { FsTree } from 'nx/src/generators/tree';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { parse } from 'yaml';

const select = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@inquirer/prompts', () => ({ select, confirm }));

const execSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync,
}));

import { DEV_DEPENDENCIES, frontendGenerator } from './frontend';
import {
  getDockerBaseImage,
  getInstallCommand,
  getLockfileName,
} from '../../shared/utils/package-manager';
import { FrontendGeneratorSchema } from './schema';
import {
  appendDockerignoreLines,
  DockerFragments,
  insertFrontendLines,
  renderDockerFragments,
} from '../../shared/utils/docker-splice';
import { frontendDockerVars } from '../../shared/utils/frontend-integration';
import {
  FhirVersion,
  FrontendProjectConfiguration,
  ServerProjectConfiguration,
} from '../../shared/models';

describe('frontend generator', () => {
  let tree: Tree;
  const options: FrontendGeneratorSchema = { name: 'test-frontend' };
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    vi.clearAllMocks();
    // Tests run as an interactive terminal session unless they say otherwise,
    // so the prompt tests do not depend on how the test runner was started.
    process.stdin.isTTY = true;
    vi.stubEnv('CI', undefined);
    vi.stubEnv('NX_INTERACTIVE', undefined);
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
    vi.unstubAllEnvs();
  });

  it('should abort when the target directory already exists', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    tree.write('test-frontend/src/main.tsx', 'existing work');

    await frontendGenerator(tree, options);

    expect(errorSpy).toHaveBeenCalledWith(
      "Directory 'test-frontend' already exists. Aborting.",
    );
    // The existing file is left alone and no project is registered over it.
    expect(tree.read('test-frontend/src/main.tsx', 'utf-8')).toBe('existing work');
    expect(tree.exists('test-frontend/project.json')).toBe(false);
    errorSpy.mockRestore();
  });

  it('should create project configuration', async () => {
    await frontendGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test-frontend');
    expect(config).toBeDefined();
    expect(config.root).toBe('test-frontend');
    expect(config.projectType).toBe('application');
    expect(config.tags).toContain('nx-fhir-frontend');
  });

  it('should add project to root package.json workspaces', async () => {
    await frontendGenerator(tree, options);
    const rootPackageJson = readJson(tree, 'package.json');
    expect(rootPackageJson.workspaces).toContain('test-frontend');
  });

  it('should keep workspaces the root package.json already declares', async () => {
    const rootPackageJson = readJson(tree, 'package.json');
    tree.write(
      'package.json',
      JSON.stringify({ ...rootPackageJson, workspaces: ['packages/*'] }),
    );

    await frontendGenerator(tree, options);

    expect(readJson(tree, 'package.json').workspaces).toEqual([
      'packages/*',
      'test-frontend',
    ]);
  });

  it('should add the project to the packages list of the object form of workspaces', async () => {
    const rootPackageJson = readJson(tree, 'package.json');
    tree.write(
      'package.json',
      JSON.stringify({ ...rootPackageJson, workspaces: { packages: ['libs/*'] } }),
    );

    await frontendGenerator(tree, options);

    expect(readJson(tree, 'package.json').workspaces.packages).toEqual([
      'libs/*',
      'test-frontend',
    ]);
  });

  it('should not duplicate workspaces entry when run twice', async () => {
    await frontendGenerator(tree, { name: 'frontend-a' });
    await frontendGenerator(tree, { name: 'frontend-b' });
    const rootPackageJson = readJson(tree, 'package.json');
    expect(rootPackageJson.workspaces).toContain('frontend-a');
    expect(rootPackageJson.workspaces).toContain('frontend-b');
    expect(rootPackageJson.workspaces.filter((w: string) => w === 'frontend-a').length).toBe(1);
  });

  it('should create vite.config.ts', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/vite.config.ts')).toBe(true);
  });

  it.each(['browser', 'clinical'] as const)(
    'should serve https with DEV_HTTPS and forward the headers in the %s vite.config.ts',
    async (template) => {
      const root = 'test-frontend';
      await frontendGenerator(tree, { ...options, template, navigationLayout: 'sidebar' });

      const viteConfig = tree.read(`${root}/vite.config.ts`, 'utf-8') as string;
      expect(viteConfig).toContain("import basicSsl from '@vitejs/plugin-basic-ssl';");
      expect(viteConfig).toContain("devEnv.DEV_HTTPS === 'true'");
      expect(viteConfig.match(/xfwd: true/g)).toHaveLength(4);
      expect(readJson(tree, `${root}/package.json`).devDependencies['@vitejs/plugin-basic-ssl']).toBe('^2.3.0');
    },
  );

  it('should create TanStack router root file', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/routes/__root.tsx')).toBe(true);
  });

  it('should not include CDS hooks route', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/routes/hooks')).toBe(false);
  });

  it('should create package.json with TanStack dependencies', async () => {
    await frontendGenerator(tree, options);
    const packageJson = readJson(tree, 'test-frontend/package.json');
    expect(packageJson.dependencies['@tanstack/react-router']).toBeDefined();
    expect(packageJson.dependencies['@tanstack/react-query']).toBeDefined();
    expect(packageJson.dependencies['@tanstack/react-table']).toBeDefined();
    expect(packageJson.dependencies['react']).toBeDefined();
    expect(packageJson.dependencies['tailwindcss']).toBeDefined();
  });

  it('should track frontend version in project config', async () => {
    await frontendGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test-frontend');
    expect((config as FrontendProjectConfiguration).frontendVersion).toBeDefined();
    expect((config as FrontendProjectConfiguration).pluginVersion).toBeDefined();
  });

  it('should create index.html with FHIR Browser title', async () => {
    await frontendGenerator(tree, options);
    const indexHtml = tree.read('test-frontend/index.html', 'utf-8');
    expect(indexHtml).toContain('<title>FHIR Browser</title>');
  });

  it('should include vitest configuration', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/vitest.config.ts')).toBe(true);
    expect(tree.exists('test-frontend/vitest.setup.ts')).toBe(true);
  });

  it('should load the jest-dom matcher types without the vitest setup file', async () => {
    await frontendGenerator(tree, options);
    expect(tree.read('test-frontend/tsconfig.json', 'utf-8')).toContain(
      '"types": ["vite/client", "@testing-library/jest-dom"]',
    );
  });

  it('should include biome configuration', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/biome.json')).toBe(true);
  });

  it('should keep the biome.json schema on the pinned biome version', async () => {
    await frontendGenerator(tree, options);
    expect(readJson(tree, 'test-frontend/biome.json').$schema).toBe(
      `https://biomejs.dev/schemas/${DEV_DEPENDENCIES['@biomejs/biome']}/schema.json`,
    );
  });

  it('should write .gitignore into the frontend', async () => {
    await frontendGenerator(tree, options);
    expect(tree.read('test-frontend/.gitignore', 'utf-8')).toContain('.tanstack');
    expect(tree.exists('test-frontend/gitignore')).toBe(false);
  });

  it('should ship no template file that packing drops', () => {
    const templateFiles = readdirSync(join(__dirname, 'files'), { recursive: true }) as string[];
    const alwaysDropped = [
      '.gitignore',
      '.npmignore',
      '.npmrc',
      '.DS_Store',
      'package-lock.json',
      'node_modules',
    ];
    const droppedByPacking = templateFiles.filter(
      (entry) => alwaysDropped.includes(basename(entry)) || entry.endsWith('.orig'),
    );
    expect(droppedByPacking).toEqual([]);
  });

  it('should create UI components', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/components/ui/button.tsx')).toBe(true);
    expect(tree.exists('test-frontend/src/components/ui/card.tsx')).toBe(true);
    expect(tree.exists('test-frontend/src/components/ui/dialog.tsx')).toBe(true);
  });

  it('should create FHIR-specific hooks', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/hooks/use-fhir-api.ts')).toBe(true);
    expect(tree.exists('test-frontend/src/hooks/use-fhir-server.ts')).toBe(true);
  });

  it('should not include CDS-related files', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/hooks/use-cds-api.ts')).toBe(false);
    expect(tree.exists('test-frontend/src/hooks/use-cds-server.ts')).toBe(false);
    expect(tree.exists('test-frontend/src/lib/cds-config.ts')).toBe(false);
    expect(tree.exists('test-frontend/src/lib/cds-types.ts')).toBe(false);
  });

  it('should default to browser template when no template specified', async () => {
    await frontendGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test-frontend');
    expect((config as FrontendProjectConfiguration).frontendTemplate).toBe('browser');
    expect(config.tags).not.toContain('clinical');
    const indexHtml = tree.read('test-frontend/index.html', 'utf-8');
    expect(indexHtml).toContain('<title>FHIR Browser</title>');
  });

  it('should include Monaco editor in browser template dependencies', async () => {
    await frontendGenerator(tree, options);
    const packageJson = readJson(tree, 'test-frontend/package.json');
    expect(packageJson.dependencies['@monaco-editor/react']).toBeDefined();
    expect(packageJson.dependencies['@tanstack/react-virtual']).toBeDefined();
    expect(packageJson.dependencies['cmdk']).toBeDefined();
  });

  describe('server integration', () => {
    const serverRoot = 'test-server';
    const yamlPath = `${serverRoot}/src/main/resources/application.yaml`;

    // Shaped like the released HAPI application.yaml: a banner comment block
    // above the tester section, and a following section after a blank line.
    const testerBlock = `    tester:
      home:
        name: Local Tester
        server_address: 'http://localhost:8080/fhir'
        fhir_version: R4
`;
    const serverYaml = `hapi:
  fhir:
    fhir_version: R4

    # -------------------------------------------------------------------------------
    # S. Testers (webui)
    # -------------------------------------------------------------------------------
${testerBlock}
    # -------------------------------------------------------------------------------
    # T. Outbound HTTP client
    # -------------------------------------------------------------------------------
    inline_resource_storage_below_size: 4000
`;

    beforeEach(() => {
      const serverConfig: ServerProjectConfiguration = {
        root: serverRoot,
        projectType: 'application',
        sourceRoot: `${serverRoot}/src`,
        tags: ['fhir', 'server'],
        packageBase: 'com.example',
        fhirVersion: FhirVersion.R4,
        hapiReleaseVersion: '8.10.0-3',
        pluginVersion: '0.0.1',
      };
      addProjectConfiguration(tree, serverRoot, serverConfig);
      tree.write(yamlPath, serverYaml);
    });

    it('should forward deep links of any shape, dotted FHIR ids included, to the SPA', async () => {
      await frontendGenerator(tree, { ...options, server: serverRoot });

      const configDir = `${serverRoot}/src/main/java/com/example/config`;
      const resolver = tree.read(`${configDir}/SpaErrorViewResolverConfiguration.java`, 'utf-8');
      expect(resolver).toMatch(/^package com\.example\.config;\n/);
      // The whole forward condition is the status and the method, so no path check can join it.
      expect(resolver).toMatch(
        /->\s*status == HttpStatus\.NOT_FOUND && HttpMethod\.GET\.matches\(request\.getMethod\(\)\)\s*\?\s*new ModelAndView\("forward:\/index\.html", model, HttpStatus\.OK\)\s*:\s*null;/,
      );
      expect(tree.exists(`${configDir}/SpaController.java`)).toBe(false);

      expect(tree.exists(`${configDir}/FhirServers.java`)).toBe(true);
      expect(tree.read(`${configDir}/ConfigController.java`, 'utf-8')).toContain('app.proxy.enabled');
      expect(tree.read(`${configDir}/ConfigController.java`, 'utf-8')).toContain('app.login.enabled');
      expect(tree.read(`${configDir}/ConfigController.java`, 'utf-8')).toContain('app.login.people.enabled');
      // Spring uses the first CORS mapping that matches, so the proxy mapping must come first.
      const cors = tree.read(`${configDir}/GlobalCorsConfiguration.java`, 'utf-8') as string;
      expect(cors.indexOf('addMapping("/proxy")')).toBeGreaterThan(-1);
      expect(cors.indexOf('addMapping("/proxy")')).toBeLessThan(cors.indexOf('addMapping("/**")'));
    });

    it('should remove only the tester section from the server configuration', async () => {
      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml.replace(testerBlock, ''));
    });

    it('should keep the comment block above the tester section', async () => {
      await frontendGenerator(tree, { ...options, server: serverRoot });

      const result = tree.read(yamlPath, 'utf-8') as string;
      expect(result).toContain('    # S. Testers (webui)\n');
      expect(result).not.toContain('Local Tester');
      expect(parse(result).hapi.fhir.tester).toBeUndefined();
      expect(parse(result).hapi.fhir.fhir_version).toBe('R4');
    });

    it('should remove the tester section from profile configuration files', async () => {
      // The profile overrides the base entry without a name and adds a second
      // entry. Either one left behind enables the tester.
      const resourcesRoot = `${serverRoot}/src/main/resources`;
      const profileYaml = `hapi:
  fhir:
    custom-bean-packages: com.example
    tester:
      home:
        server_address: 'https://example.org/fhir'
      global:
        name: Global Tester
        server_address: "http://hapi.fhir.org/baseR4"
        refuse_to_fetch_third_party_urls: false
        fhir_version: R4

spring:
  datasource:
    url: jdbc:h2:mem:test
`;
      const cdsYaml = 'hapi:\n  fhir:\n    cds_hooks:\n      enabled: true\n';
      tree.write(`${resourcesRoot}/application-default.yaml`, profileYaml);
      tree.write(`${resourcesRoot}/application-cds.yaml`, cdsYaml);

      await frontendGenerator(tree, { ...options, server: serverRoot });

      const result = tree.read(`${resourcesRoot}/application-default.yaml`, 'utf-8') as string;
      expect(parse(result).hapi.fhir.tester).toBeUndefined();
      expect(result).toBe(`hapi:
  fhir:
    custom-bean-packages: com.example

spring:
  datasource:
    url: jdbc:h2:mem:test
`);
      expect(tree.read(`${resourcesRoot}/application-cds.yaml`, 'utf-8')).toBe(cdsYaml);
    });

    it('should leave a configuration without a tester section unchanged', async () => {
      const withoutTester = serverYaml.replace(testerBlock, '');
      tree.write(yamlPath, withoutTester);

      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read(yamlPath, 'utf-8')).toBe(withoutTester);
    });

    it('should preserve an existing Dockerfile as Dockerfile.orig before writing the combined one', async () => {
      tree.write('Dockerfile', 'FROM starter\n');

      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read('Dockerfile.orig', 'utf-8')).toBe('FROM starter\n');
      expect(tree.read('Dockerfile', 'utf-8')).toContain('build-frontend');
    });

    it('should keep the first backup when the integration runs again', async () => {
      tree.write('Dockerfile', 'FROM starter\n');
      tree.write('Dockerfile.orig', 'FROM original\n');

      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read('Dockerfile.orig', 'utf-8')).toBe('FROM original\n');
    });

    it('should install from the workspace root in the Dockerfile', async () => {
      await frontendGenerator(tree, { ...options, server: serverRoot });

      const dockerfile = tree.read('Dockerfile', 'utf-8') as string;
      expect(dockerfile).toMatch(
        /^COPY package\.json (bun\.lock|package-lock\.json) \.\/$/m
      );
      expect(dockerfile).toContain(
        'COPY test-frontend/package.json ./test-frontend/'
      );
      expect(dockerfile).not.toContain('COPY test-frontend/bun.lock');
      expect(dockerfile).not.toContain('COPY test-frontend/package-lock.json');
      expect(dockerfile).not.toMatch(
        /WORKDIR \/app\/test-frontend\nRUN (bun install|npm ci)/
      );
    });

    it('should build the server like the latest HAPI starter in the Dockerfile', async () => {
      await frontendGenerator(tree, { ...options, server: serverRoot });

      const dockerfile = tree.read('Dockerfile', 'utf-8') as string;
      expect(dockerfile).toContain(
        'FROM docker.io/library/maven:3.9.12-eclipse-temurin-17 AS build-server'
      );
      expect(dockerfile).toContain('ARG OPENTELEMETRY_JAVA_AGENT_VERSION=2.24.0');
      expect(dockerfile).toContain('COPY test-server/server.xml .');
      expect(dockerfile).toContain(
        'FROM docker.io/library/tomcat:10-jre21-temurin-noble AS tomcat'
      );
      expect(dockerfile).toContain(
        'COPY --chown=65532:65532 test-server/catalina.properties /usr/local/tomcat/conf/catalina.properties'
      );
      expect(dockerfile).toContain(
        'COPY --from=build-server --chown=65532:65532 /tmp/hapi-fhir-jpaserver-starter/target/ROOT.war /usr/local/tomcat/webapps/ROOT.war'
      );
      expect(dockerfile).toContain(
        'FROM gcr.io/distroless/java21-debian13:nonroot AS default'
      );
      // The default target is the last stage.
      expect(dockerfile.lastIndexOf('FROM ')).toBe(
        dockerfile.indexOf('FROM gcr.io/distroless/java21-debian13:nonroot AS default')
      );
      expect(dockerfile).not.toContain('HealthCheck');
    });

    it('should compile the server health check in the Dockerfile when the server has one', async () => {
      tree.write(
        `${serverRoot}/src/main/java/HealthCheck.java`,
        'public final class HealthCheck {}\n'
      );

      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read('Dockerfile', 'utf-8')).toContain(
        'COPY test-server/src/main/java/HealthCheck.java /app/HealthCheck.java\nRUN javac /app/HealthCheck.java\n'
      );
    });

    it('should render the same frontend stage in the combined Dockerfile', async () => {
      await frontendGenerator(tree, { ...options, server: serverRoot });

      const fragments = renderDockerFragments(
        join(__dirname, 'files'),
        await frontendDockerVars(tree, 'test-frontend', serverRoot)
      );
      expect(fragments).not.toBeNull();
      expect(tree.read('Dockerfile', 'utf-8')).toContain(
        fragments?.frontendStage
      );
    });

    it('should integrate with the server the user picks when none is named', async () => {
      select.mockResolvedValue(serverRoot);
      const passedOptions = { ...options };

      await frontendGenerator(tree, passedOptions);

      // The picked server is used without writing it back to the caller's options.
      expect(passedOptions.server).toBeUndefined();
      expect(select).toHaveBeenCalledTimes(1);
      const config = readProjectConfiguration(tree, 'test-frontend');
      expect(config.targets?.['copy-to-server']).toBeDefined();
      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml.replace(testerBlock, ''));
    });

    it('should integrate a picked server whose name differs from its root', async () => {
      // The workspace has no starter Dockerfile, so the integration warns.
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      // An imported server keeps its own name and lives at the workspace root.
      removeProjectConfiguration(tree, serverRoot);
      addProjectConfiguration(tree, 'imported-server', {
        root: '.',
        projectType: 'application',
        sourceRoot: 'src',
        tags: ['fhir', 'server'],
        packageBase: 'com.example',
        fhirVersion: FhirVersion.R4,
      } as ServerProjectConfiguration);
      tree.write('src/main/resources/application.yaml', serverYaml);
      select.mockImplementationOnce(async ({ choices }) =>
        choices.find((choice: { value: string }) => choice.value !== 'none').value
      );

      await frontendGenerator(tree, { ...options });

      const config = readProjectConfiguration(tree, 'test-frontend');
      expect(config.targets?.['copy-to-server']).toBeDefined();
      expect(tree.read('src/main/resources/application.yaml', 'utf-8')).toBe(
        serverYaml.replace(testerBlock, '')
      );
      warnSpy.mockRestore();
    });

    it('should skip integration when the user picks no server', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      select.mockResolvedValue('none');

      await frontendGenerator(tree, { ...options });

      expect(select).toHaveBeenCalledTimes(1);
      // The proxy question needs an integrated server.
      expect(confirm).not.toHaveBeenCalled();
      // "none" is a deliberate skip, not a server that failed to resolve.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        'No server project selected for integration. Skipping integration step.',
      );
      const config = readProjectConfiguration(tree, 'test-frontend');
      expect(config.targets?.['copy-to-server']).toBeUndefined();
      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml);
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should detect the package manager from the lockfile at the workspace root', async () => {
      // Detection without a directory reads the current directory. A root
      // lockfile of a different package manager makes that detection visible.
      const managerAtRoot = detectPackageManager() === 'npm' ? 'bun' : 'npm';
      const workspaceDir = mkdtempSync(join(tmpdir(), 'nx-fhir-pm-root-'));
      try {
        writeFileSync(join(workspaceDir, 'nx.json'), '{}');
        writeFileSync(join(workspaceDir, 'package.json'), JSON.stringify({ name: 'ws' }));
        writeFileSync(join(workspaceDir, getLockfileName(managerAtRoot)), '');
        const workspaceTree = new FsTree(workspaceDir, false);
        addProjectConfiguration(
          workspaceTree,
          serverRoot,
          readProjectConfiguration(tree, serverRoot),
        );
        workspaceTree.write(yamlPath, serverYaml);

        const install = await frontendGenerator(workspaceTree, {
          ...options,
          server: serverRoot,
        });
        install?.();

        expect(workspaceTree.read('Dockerfile', 'utf-8')).toContain(
          `FROM ${getDockerBaseImage(managerAtRoot)} AS build-frontend`,
        );
        expect(execSync).toHaveBeenCalledWith(
          getInstallCommand(managerAtRoot),
          expect.anything(),
        );
      } finally {
        rmSync(workspaceDir, { recursive: true, force: true });
      }
    });

    it('should skip integration without prompting in a non-interactive run', async () => {
      vi.stubEnv('NX_INTERACTIVE', 'false');
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

      await frontendGenerator(tree, { ...options });

      expect(select).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(/test-server.*--server=<name>/),
      );
      const config = readProjectConfiguration(tree, 'test-frontend');
      expect(config.targets?.['copy-to-server']).toBeUndefined();
      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml);
      infoSpy.mockRestore();
    });

    it('should report a named server project that is not in the workspace', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

      await frontendGenerator(tree, { ...options, server: 'no-such-server' });

      expect(errorSpy).toHaveBeenCalledWith(
        "Server project 'no-such-server' not found.",
      );
      // The frontend is still generated; only the integration step is skipped.
      const config = readProjectConfiguration(tree, 'test-frontend');
      expect(config.targets?.['copy-to-server']).toBeUndefined();
      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml);
      errorSpy.mockRestore();
    });

    describe('proxy option', () => {
      const pomPath = `${serverRoot}/pom.xml`;
      const proxyControllerPath = `${serverRoot}/src/main/java/com/example/proxy/FrontendProxyController.java`;
      const envPath = 'test-frontend/.env.development';
      const devServerLine = 'DEV_SERVER_URL=http://localhost:8080';
      const proxyQuestion = 'Route requests to other servers through this server?';

      const starterPom = (hapiVersion: string) => `<?xml version="1.0" encoding="UTF-8"?>
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

      const serverFeatures = () =>
        (readProjectConfiguration(tree, serverRoot) as ServerProjectConfiguration).features;

      beforeEach(() => {
        tree.write(pomPath, starterPom('8.12.0'));
      });

      it('leaves proxy unset on the command line so the generator can ask', () => {
        // Nx fills schema defaults before the generator runs, so a schema default would skip the question.
        const schema = JSON.parse(readFileSync(join(__dirname, 'schema.json'), 'utf-8'));
        expect(schema.properties.proxy.type).toBe('boolean');
        expect(schema.properties.proxy).not.toHaveProperty('default');
      });

      it('does not install the proxy by default', async () => {
        vi.stubEnv('NX_INTERACTIVE', 'false');

        await frontendGenerator(tree, { ...options, server: serverRoot });

        expect(confirm).not.toHaveBeenCalled();
        expect(serverFeatures()).toBeUndefined();
        expect(tree.exists(proxyControllerPath)).toBe(false);
        expect(tree.exists(envPath)).toBe(false);
      });

      it('installs the proxy with --proxy', async () => {
        vi.stubEnv('NX_INTERACTIVE', 'false');

        await frontendGenerator(tree, { ...options, server: serverRoot, proxy: true });

        expect(confirm).not.toHaveBeenCalled();
        expect(serverFeatures()?.['frontend-proxy']).toMatchObject({
          options: { passthrough: false },
        });
        expect(tree.exists(proxyControllerPath)).toBe(true);
        expect(parse(tree.read(yamlPath, 'utf-8') as string).app.proxy.enabled).toBe(true);
        expect(tree.read(envPath, 'utf-8')).toBe(`${devServerLine}\n`);
      });

      it('asks when interactive and installs on yes', async () => {
        confirm.mockResolvedValueOnce(true);

        await frontendGenerator(tree, { ...options, server: serverRoot });

        expect(confirm).toHaveBeenNthCalledWith(1, { message: proxyQuestion, default: false });
        expect(serverFeatures()?.['frontend-proxy']).toBeDefined();
        expect(tree.read(envPath, 'utf-8')).toBe(`${devServerLine}\n`);
      });

      describe('when the server already has the proxy', () => {
        const installed = { version: 1, options: { passthrough: true } };
        let warnSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
          const server = readProjectConfiguration(tree, serverRoot) as ServerProjectConfiguration;
          updateProjectConfiguration(tree, serverRoot, {
            ...server,
            features: { 'frontend-proxy': installed },
          } as ServerProjectConfiguration);
          warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        });

        afterEach(() => {
          warnSpy.mockRestore();
        });

        // The runner refuses a second install with an error that the generator prints as a warning,
        // so no warning and an unchanged server show that the runner did not run.
        const expectOnlyTheEnvLine = () => {
          expect(confirm).not.toHaveBeenCalled();
          expect(tree.read(envPath, 'utf-8')).toBe(`${devServerLine}\n`);
          expect(warnSpy).not.toHaveBeenCalled();
          expect(serverFeatures()).toEqual({ 'frontend-proxy': installed });
          expect(tree.exists(proxyControllerPath)).toBe(false);
          expect(tree.read(pomPath, 'utf-8')).toBe(starterPom('8.12.0'));
        };

        it('writes only the env line when the server already has the proxy', async () => {
          vi.stubEnv('NX_INTERACTIVE', 'false');
          const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

          await frontendGenerator(tree, { ...options, server: serverRoot });

          expectOnlyTheEnvLine();
          expect(infoSpy).toHaveBeenCalledWith(
            "Server project 'test-server' already has the frontend proxy. Frontend 'test-frontend' is set up to use it.",
          );
          infoSpy.mockRestore();
        });

        it('does not ask in an interactive run', async () => {
          await frontendGenerator(tree, { ...options, server: serverRoot });

          expectOnlyTheEnvLine();
        });

        it('writes the env line with --proxy=false', async () => {
          await frontendGenerator(tree, { ...options, server: serverRoot, proxy: false });

          expectOnlyTheEnvLine();
        });

        it('does not install again with --proxy', async () => {
          await frontendGenerator(tree, { ...options, server: serverRoot, proxy: true });

          expectOnlyTheEnvLine();
        });

        it.each([
          ['viteHttps true', { 'auth-login': { version: 1, options: { viteHttps: true } } }, true],
          ['viteHttps false', { 'auth-login': { version: 1, options: { viteHttps: false } } }, false],
          ['no auth-login', {}, false],
        ])('writes DEV_HTTPS=true only when auth-login records viteHttps true: %s', async (_, features, expected) => {
          vi.stubEnv('NX_INTERACTIVE', 'false');
          const server = readProjectConfiguration(tree, serverRoot) as ServerProjectConfiguration;
          updateProjectConfiguration(tree, serverRoot, {
            ...server,
            features: { 'frontend-proxy': installed, ...features },
          } as ServerProjectConfiguration);

          await frontendGenerator(tree, { ...options, server: serverRoot });

          expect(tree.read(envPath, 'utf-8')).toBe(
            expected ? `${devServerLine}\nDEV_HTTPS=true\n` : `${devServerLine}\n`,
          );
        });
      });

      it('warns and continues when the server is below HAPI 8.8.0', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        tree.write(pomPath, starterPom('8.6.0'));

        await frontendGenerator(tree, { ...options, server: serverRoot, proxy: true });

        expect(tree.exists('test-frontend/src/lib/fhir-config.ts')).toBe(true);
        expect(readProjectConfiguration(tree, 'test-frontend').targets?.['copy-to-server']).toBeDefined();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(
            /^Skipped the install of feature 'frontend-proxy' on server project 'test-server'\. The frontend is generated without the proxy\. Reason: Feature 'frontend-proxy' supports HAPI FHIR 8\.8\.0 and later, but project 'test-server' builds against HAPI FHIR 8\.6\.0/,
          ),
        );
        expect(serverFeatures()).toBeUndefined();
        expect(tree.exists(proxyControllerPath)).toBe(false);
        expect(tree.exists(envPath)).toBe(false);
        warnSpy.mockRestore();
      });

      it('stops the run when the passthrough prompt is cancelled', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const cancelled = Object.assign(new Error('User force closed the prompt with 0 SIGINT'), {
          name: 'ExitPromptError',
        });
        confirm.mockRejectedValueOnce(cancelled);

        await expect(
          frontendGenerator(tree, { ...options, server: serverRoot, proxy: true }),
        ).rejects.toBe(cancelled);

        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Skipped the install'));
        warnSpy.mockRestore();
      });

      it('ignores --proxy when no server is integrated', async () => {
        vi.stubEnv('NX_INTERACTIVE', 'false');
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

        await frontendGenerator(tree, { ...options, proxy: true });

        expect(confirm).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          'The proxy option needs a server project that the frontend is integrated with. The generator does not install the proxy.',
        );
        expect(serverFeatures()).toBeUndefined();
        expect(tree.exists(envPath)).toBe(false);
        warnSpy.mockRestore();
      });
    });

    describe('server-root layout', () => {
      const serverName = 'imported-server';
      const fixtureDir = join(__dirname, '../../shared/utils/__fixtures__/starter-docker');
      const readFixture = (file: string) => readFileSync(join(fixtureDir, file), 'utf-8');
      const starterFiles = JSON.parse(readFixture('releases.json'))['8.12.0-2'];
      const starterDockerfile = readFixture(starterFiles.dockerfile);
      const starterIgnore = readFixture(starterFiles.dockerignore);

      const generate = (name = 'test-frontend') =>
        frontendGenerator(tree, { ...options, name, server: serverName });

      // The variables read the root package.json workspaces, which the
      // generator changes, so the fragments render after the generator runs.
      const renderedFragments = async () =>
        renderDockerFragments(
          join(__dirname, 'files'),
          await frontendDockerVars(tree, 'test-frontend', '.')
        ) as DockerFragments;

      beforeEach(() => {
        removeProjectConfiguration(tree, serverRoot);
        addProjectConfiguration(tree, serverName, {
          root: '.',
          projectType: 'application',
          sourceRoot: 'src',
          tags: ['fhir', 'server'],
          packageBase: 'com.example',
          fhirVersion: FhirVersion.R4,
        } as ServerProjectConfiguration);
        tree.write('src/main/resources/application.yaml', serverYaml);
        tree.write('Dockerfile', starterDockerfile);
        tree.write('.dockerignore', starterIgnore);
      });

      it('should add the frontend lines to the starter Dockerfile', async () => {
        await generate();

        const fragments = await renderedFragments();
        expect(tree.read('Dockerfile', 'utf-8')).toBe(
          insertFrontendLines(starterDockerfile, fragments)
        );
        expect(tree.read('.dockerignore', 'utf-8')).toBe(
          appendDockerignoreLines(starterIgnore, fragments.dockerignoreLines)
        );
      });

      it('should keep no .orig files', async () => {
        await generate();

        expect(tree.exists('Dockerfile.orig')).toBe(false);
        expect(tree.exists('.dockerignore.orig')).toBe(false);
      });

      it('should warn and change nothing for a second frontend', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        await generate();
        const firstRun = [tree.read('Dockerfile', 'utf-8'), tree.read('.dockerignore', 'utf-8')];

        // A run with the same name stops at the existing frontend directory
        // before the integration, so the second run adds another frontend.
        await generate('second-frontend');

        expect([tree.read('Dockerfile', 'utf-8'), tree.read('.dockerignore', 'utf-8')]).toEqual(
          firstRun
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(
            /^Dockerfile has a build-frontend stage for a frontend other than 'second-frontend'\. The server image builds only the frontend that is already in the stage\. The generator does not change Dockerfile or \.dockerignore\.$/
          )
        );
        warnSpy.mockRestore();
      });

      it('should change nothing when the same frontend is generated again', async () => {
        const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        await generate();
        const firstRun = [tree.read('Dockerfile', 'utf-8'), tree.read('.dockerignore', 'utf-8')];

        tree.delete('test-frontend');
        await generate();

        expect([tree.read('Dockerfile', 'utf-8'), tree.read('.dockerignore', 'utf-8')]).toEqual(
          firstRun
        );
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringMatching(/^Dockerfile already has a build-frontend stage\./)
        );
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('build-frontend stage'));
        infoSpy.mockRestore();
        warnSpy.mockRestore();
      });

      it('should leave both files unchanged and warn when the COPY src/ line is missing', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const withoutCopySource = starterDockerfile.replace(/^COPY src\/ .*\n/m, '');
        expect(withoutCopySource).not.toBe(starterDockerfile);
        tree.write('Dockerfile', withoutCopySource);

        await generate();

        const fragments = await renderedFragments();
        expect(tree.read('Dockerfile', 'utf-8')).toBe(withoutCopySource);
        expect(tree.read('.dockerignore', 'utf-8')).toBe(starterIgnore);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(fragments.copyFrontend.trim())
        );
        warnSpy.mockRestore();
      });

      it('should warn when the Dockerfile is missing', async () => {
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        tree.delete('Dockerfile');

        await generate();

        expect(tree.exists('Dockerfile')).toBe(false);
        expect(tree.read('.dockerignore', 'utf-8')).toBe(starterIgnore);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dockerfile does not exist'));
        warnSpy.mockRestore();
      });

      it('should create a missing .dockerignore with the frontend lines', async () => {
        tree.delete('.dockerignore');

        await generate();

        const fragments = await renderedFragments();
        expect(tree.read('.dockerignore', 'utf-8')).toBe(fragments.dockerignoreLines);
      });
    });
  });

  describe('clinical template', () => {
    const clinicalOptions: FrontendGeneratorSchema = {
      name: 'test-clinical',
      template: 'clinical',
      navigationLayout: 'sidebar',
    };

    it('should create project config with clinical tag', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const config = readProjectConfiguration(tree, 'test-clinical');
      expect(config).toBeDefined();
      expect(config.tags).toContain('clinical');
      expect(config.tags).toContain('nx-fhir-frontend');
      expect(config.tags).toContain('fhir');
    });

    it('should store frontendTemplate in project config', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const config = readProjectConfiguration(tree, 'test-clinical');
      expect((config as FrontendProjectConfiguration).frontendTemplate).toBe('clinical');
      expect((config as FrontendProjectConfiguration).frontendVersion).toBeDefined();
    });

    it('should create index.html with Clinical Portal title', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const indexHtml = tree.read('test-clinical/index.html', 'utf-8');
      expect(indexHtml).toContain('<title>Clinical Portal</title>');
    });

    it('should create patient routes', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/src/routes/index.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/routes/patients/$patientId.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/routes/patients/$patientId/index.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/routes/patients/$patientId/conditions.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/routes/patients/$patientId/medications.tsx')).toBe(true);
    });

    it('should not include browser-specific files', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/src/components/data-table')).toBe(false);
      expect(tree.exists('test-clinical/src/components/command-palette.tsx')).toBe(false);
      expect(tree.exists('test-clinical/src/routes/resources')).toBe(false);
      expect(tree.exists('test-clinical/src/lib/fhir-columns.tsx')).toBe(false);
      expect(tree.exists('test-clinical/src/lib/resource-icons.ts')).toBe(false);
    });

    it('should include clinical-specific hooks and components', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/src/hooks/use-clinical-api.ts')).toBe(true);
      expect(tree.exists('test-clinical/src/components/patient-search.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/patient-header.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/clinical-table.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/lib/clinical-formatters.ts')).toBe(true);
    });

    it('should not include browser-only dependencies', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const packageJson = readJson(tree, 'test-clinical/package.json');
      expect(packageJson.dependencies['@tanstack/react-virtual']).toBeUndefined();
      expect(packageJson.dependencies['cmdk']).toBeUndefined();
      expect(packageJson.dependencies['nuqs']).toBeUndefined();
    });

    it('should include shared dependencies', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const packageJson = readJson(tree, 'test-clinical/package.json');
      expect(packageJson.dependencies['@tanstack/react-router']).toBeDefined();
      expect(packageJson.dependencies['@tanstack/react-query']).toBeDefined();
      expect(packageJson.dependencies['@tanstack/react-table']).toBeDefined();
      expect(packageJson.dependencies['react']).toBeDefined();
      expect(packageJson.dependencies['tailwindcss']).toBeDefined();
    });

    it('should include shared UI components', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/src/components/ui/button.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/ui/card.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/ui/badge.tsx')).toBe(true);
    });

    it('should include shared config and build files', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/vite.config.ts')).toBe(true);
      expect(tree.exists('test-clinical/vitest.config.ts')).toBe(true);
      expect(tree.exists('test-clinical/biome.json')).toBe(true);
      expect(tree.exists('test-clinical/tsconfig.json')).toBe(true);
    });

    it('should default to sidebar navigation layout', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const config = readProjectConfiguration(tree, 'test-clinical');
      expect((config as FrontendProjectConfiguration).navigationLayout).toBe('sidebar');
      expect(tree.exists('test-clinical/src/components/app-sidebar.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/ui/sidebar.tsx')).toBe(true);
    });

    it('should not include variant files in output', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/_variants')).toBe(false);
    });

    describe('topnav navigation layout', () => {
      const topnavOptions: FrontendGeneratorSchema = {
        name: 'test-topnav',
        template: 'clinical',
        navigationLayout: 'topnav',
      };

      it('should store navigationLayout in project config', async () => {
        await frontendGenerator(tree, topnavOptions);
        const config = readProjectConfiguration(tree, 'test-topnav');
        expect((config as FrontendProjectConfiguration).navigationLayout).toBe('topnav');
      });

      it('should create __root.tsx with top navigation', async () => {
        await frontendGenerator(tree, topnavOptions);
        expect(tree.exists('test-topnav/src/routes/__root.tsx')).toBe(true);
        const root = tree.read('test-topnav/src/routes/__root.tsx', 'utf-8');
        expect(root).not.toContain('SidebarProvider');
        expect(root).not.toContain('AppSidebar');
      });

      it('should not include sidebar components', async () => {
        await frontendGenerator(tree, topnavOptions);
        expect(tree.exists('test-topnav/src/components/app-sidebar.tsx')).toBe(false);
        expect(tree.exists('test-topnav/src/components/ui/sidebar.tsx')).toBe(false);
        expect(tree.exists('test-topnav/src/components/ui/sheet.tsx')).toBe(false);
      });

      it('should use the layout the user picks when none is given', async () => {
        select.mockResolvedValue('topnav');

        await frontendGenerator(tree, {
          name: 'test-prompted',
          template: 'clinical',
        });

        expect(select).toHaveBeenCalledTimes(1);
        const config = readProjectConfiguration(tree, 'test-prompted');
        expect((config as FrontendProjectConfiguration).navigationLayout).toBe(
          'topnav',
        );
        const root = tree.read('test-prompted/src/routes/__root.tsx', 'utf-8');
        expect(root).not.toContain('SidebarProvider');
      });

      it('should use the sidebar layout without prompting in a non-interactive run', async () => {
        vi.stubEnv('NX_INTERACTIVE', 'false');
        const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

        await frontendGenerator(tree, {
          name: 'test-unprompted',
          template: 'clinical',
        });

        expect(select).not.toHaveBeenCalled();
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining('--navigationLayout'),
        );
        const config = readProjectConfiguration(tree, 'test-unprompted');
        expect((config as FrontendProjectConfiguration).navigationLayout).toBe(
          'sidebar',
        );
        infoSpy.mockRestore();
      });

      it('should still include clinical-specific components', async () => {
        await frontendGenerator(tree, topnavOptions);
        expect(tree.exists('test-topnav/src/components/patient-search.tsx')).toBe(true);
        expect(tree.exists('test-topnav/src/components/patient-header.tsx')).toBe(true);
        expect(tree.exists('test-topnav/src/components/clinical-table.tsx')).toBe(true);
      });
    });
  });
});
