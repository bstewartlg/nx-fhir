import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readJson, readProjectConfiguration, Tree } from '@nx/devkit';

import { importServerGenerator } from './import-server';
import { ImportServerGeneratorSchema } from './schema';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';
import {
  detectExistingServer,
  detectFhirVersionFromYaml,
  detectHapiVersionFromPom,
} from '../../shared/utils/server-detection';

function pomXml(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>ca.uhn.hapi.fhir</groupId>
  <artifactId>hapi-fhir-jpaserver-starter</artifactId>
  <version>${version}</version>
  <packaging>war</packaging>
  <parent>
    <groupId>ca.uhn.hapi.fhir</groupId>
    <artifactId>hapi-fhir</artifactId>
    <version>${version}</version>
  </parent>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.3.0</version>
    </dependency>
  </dependencies>
</project>
`;
}

function applicationYaml(fhirVersion: string): string {
  return `spring:
  datasource:
    url: jdbc:h2:mem:test
hapi:
  fhir:
    fhir_version: ${fhirVersion}
    server_address: http://localhost:8080/fhir
`;
}

function writeFakeServer(
  tree: Tree,
  root: string,
  opts: { version?: string; fhirVersion?: string; packageBase?: string } = {},
) {
  const version = opts.version ?? '8.8.0';
  const fhirVersion = opts.fhirVersion ?? 'R4';
  const packageBase = opts.packageBase ?? 'org.test.server';
  const prefix = root === '.' ? '' : `${root}/`;
  const packageDir = packageBase.replace(/\./g, '/');

  tree.write(`${prefix}pom.xml`, pomXml(version));
  tree.write(`${prefix}src/main/resources/application.yaml`, applicationYaml(fhirVersion));
  tree.write(
    `${prefix}src/main/java/${packageDir}/common/BaseProvider.java`,
    `package ${packageBase}.common;\npublic class BaseProvider {}\n`,
  );
  // A HAPI starter source file that must be ignored by package detection.
  tree.write(
    `${prefix}src/main/java/ca/uhn/fhir/jpa/starter/Application.java`,
    `package ca.uhn.fhir.jpa.starter;\npublic class Application {}\n`,
  );
}

describe('import-server generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('registers an existing server in a subdirectory without modifying its files', async () => {
    writeFakeServer(tree, 'existing-server');
    const pomBefore = tree.read('existing-server/pom.xml', 'utf-8');
    const yamlBefore = tree.read(
      'existing-server/src/main/resources/application.yaml',
      'utf-8',
    );

    const options: ImportServerGeneratorSchema = {
      directory: 'existing-server',
      name: 'existing-server',
      release: '8.8.0-1',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    };

    await importServerGenerator(tree, options);

    const config = readProjectConfiguration(tree, 'existing-server');
    expect(config.root).toBe('existing-server');
    expect(config.sourceRoot).toBe('existing-server/src');
    expect(config.projectType).toBe('application');
    expect(config.tags).toContain('nx-fhir-server');
    expect((config as ServerProjectConfiguration).hapiReleaseVersion).toBe('8.8.0-1');
    expect((config as ServerProjectConfiguration).fhirVersion).toBe('R4');
    expect((config as ServerProjectConfiguration).packageBase).toBe('org.test.server');
    expect((config as ServerProjectConfiguration).pluginVersion).toBeTruthy();

    // nx-fhir plugin registered
    const nxJson = readJson(tree, 'nx.json');
    expect(nxJson.plugins).toContain('nx-fhir');

    // Non-destructive: existing files untouched
    expect(tree.read('existing-server/pom.xml', 'utf-8')).toBe(pomBefore);
    expect(
      tree.read('existing-server/src/main/resources/application.yaml', 'utf-8'),
    ).toBe(yamlBefore);
  });

  it('registers a server living at the workspace root with sourceRoot "src"', async () => {
    writeFakeServer(tree, '.', { version: '8.4.0' });

    await importServerGenerator(tree, {
      directory: '.',
      name: 'root-server',
      release: '8.4.0',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    });

    const config = readProjectConfiguration(tree, 'root-server');
    expect(config.root).toBe('.');
    expect(config.sourceRoot).toBe('src');
    expect((config as ServerProjectConfiguration).hapiReleaseVersion).toBe('8.4.0');
  });

  it('opts the root package.json out of script inference to avoid serve/build/test recursion', async () => {
    writeFakeServer(tree, '.', { version: '8.4.0' });

    await importServerGenerator(tree, {
      directory: '.',
      name: 'root-server',
      release: '8.4.0',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    });

    // Without this, Nx infers the workspace `nx run-many -t serve` script as the root
    // project's `serve` target, which recurses into itself.
    const packageJson = readJson(tree, 'package.json');
    expect(packageJson.nx?.includedScripts).toEqual([]);
  });

  it('does not touch package.json script inference for a server in a subdirectory', async () => {
    writeFakeServer(tree, 'srv', { version: '8.4.0' });

    await importServerGenerator(tree, {
      directory: 'srv',
      name: 'srv',
      release: '8.4.0',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    });

    const packageJson = readJson(tree, 'package.json');
    expect(packageJson.nx?.includedScripts).toBeUndefined();
  });

  it('applies the provided name and unions tags when a project.json already exists', async () => {
    writeFakeServer(tree, 'srv');
    tree.write(
      'srv/project.json',
      JSON.stringify(
        {
          name: 'old-name',
          projectType: 'application',
          sourceRoot: 'srv/src',
          tags: ['custom-tag'],
        },
        null,
        2,
      ),
    );

    await importServerGenerator(tree, {
      directory: 'srv',
      name: 'new-name',
      release: '8.8.0-1',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    });

    const pj = readJson(tree, 'srv/project.json');
    expect(pj.name).toBe('new-name');
    expect(pj.tags).toEqual(
      expect.arrayContaining(['custom-tag', 'nx-fhir-server', 'fhir', 'server']),
    );
    expect(pj.hapiReleaseVersion).toBe('8.8.0-1');
  });

  it('keeps the existing project name when none is provided', async () => {
    writeFakeServer(tree, 'srv');
    tree.write(
      'srv/project.json',
      JSON.stringify(
        { name: 'keep-me', projectType: 'application', sourceRoot: 'srv/src' },
        null,
        2,
      ),
    );

    await importServerGenerator(tree, {
      directory: 'srv',
      release: '8.8.0-1',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    });

    expect(readJson(tree, 'srv/project.json').name).toBe('keep-me');
  });

  it('throws a clear error when no HAPI server is present', async () => {
    await expect(
      importServerGenerator(tree, { directory: 'nope' }),
    ).rejects.toThrow(/No existing HAPI FHIR server found/);
  });

  it('uses provided options without prompting and detection fills the rest', async () => {
    writeFakeServer(tree, 'srv', { version: '8.6.0', fhirVersion: 'R4B' });

    // Only directory + release provided; fhirVersion + packageBase come from detection.
    await importServerGenerator(tree, {
      directory: 'srv',
      name: 'srv',
      release: '8.6.0-1',
    });

    const config = readProjectConfiguration(tree, 'srv');
    expect((config as ServerProjectConfiguration).fhirVersion).toBe('R4B');
    expect((config as ServerProjectConfiguration).packageBase).toContain('org.test.server');
  });
});

describe('server-detection utilities', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('correlates pom versions to supported starter releases', () => {
    expect(detectHapiVersionFromPom(pomXml('8.8.0'))).toBe('8.8.0-1');
    expect(detectHapiVersionFromPom(pomXml('8.6.0'))).toBe('8.6.0-1');
    expect(detectHapiVersionFromPom(pomXml('8.4.0'))).toBe('8.4.0');
    expect(detectHapiVersionFromPom(pomXml('8.2.0'))).toBe('8.2.0');
    expect(detectHapiVersionFromPom(pomXml('9.9.9'))).toBeUndefined();
  });

  it('reads the FHIR version from application.yaml', () => {
    expect(detectFhirVersionFromYaml(applicationYaml('R5'))).toBe(FhirVersion.R5);
    expect(detectFhirVersionFromYaml('spring:\n  main: {}\n')).toBeUndefined();
  });

  it('returns null when pom.xml lacks a HAPI marker', () => {
    tree.write('plain/pom.xml', '<project><artifactId>not-hapi</artifactId></project>');
    tree.write('plain/src/main/resources/application.yaml', 'spring:\n  main: {}\n');
    expect(detectExistingServer(tree, 'plain')).toBeNull();
  });

  it('detects a full server and its metadata', () => {
    writeFakeServer(tree, 'srv', { version: '8.8.0', fhirVersion: 'R4' });
    const detected = detectExistingServer(tree, 'srv');
    expect(detected).not.toBeNull();
    expect(detected?.root).toBe('srv');
    expect(detected?.fhirVersion).toBe(FhirVersion.R4);
    expect(detected?.hapiReleaseVersion).toBe('8.8.0-1');
    expect(detected?.packageBase).toBe('org.test.server.common');
  });
});
