import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { logger, readProjectConfiguration, Tree } from '@nx/devkit';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

const select = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ select }));

import {
  createCustomSourceFiles,
  createHapiFiles,
  downloadAndExtract,
  isStarterProjectFile,
  serverGenerator,
} from './server';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';
import { SUPPORTED_HAPI_VERSIONS } from '../../shared/constants/versions';

const fixtureArchive = join(__dirname, '__fixtures__', 'starter-image.zip');

function stubFetchWithFixture() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(readFileSync(fixtureArchive))),
  );
}

describe('isStarterProjectFile', () => {
  it('keeps sources and the project-level starter files', () => {
    expect(isStarterProjectFile('src/main/resources/application.yaml')).toBe(
      true,
    );
    expect(isStarterProjectFile('pom.xml')).toBe(true);
    expect(isStarterProjectFile('Dockerfile')).toBe(true);
    expect(isStarterProjectFile('.gitignore')).toBe(true);
  });

  it('drops repository files that do not belong in a project', () => {
    expect(isStarterProjectFile('charts/hapi-fhir-jpaserver/Chart.yaml')).toBe(
      false,
    );
    expect(isStarterProjectFile('.github/workflows/build.yml')).toBe(false);
    expect(isStarterProjectFile('README.md')).toBe(false);
    expect(isStarterProjectFile('server/pom.xml')).toBe(false);
  });
});

describe('template file generation', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('creates the starter server config with the package base rendered', () => {
    createHapiFiles(tree, 'server', 'org.acme.fhir');

    const configPath =
      'server/src/main/java/ca/uhn/fhir/jpa/starter/CustomServerConfig.java';
    expect(tree.exists(configPath)).toBe(true);
    expect(tree.read(configPath, 'utf-8')).not.toContain('<%=');
    expect(tree.read(configPath, 'utf-8')).toContain('org.acme.fhir');
  });

  it('creates custom source files in the directory derived from the package base', () => {
    createCustomSourceFiles(tree, 'server', 'org.acme.fhir');

    const files = tree
      .listChanges()
      .map((c) => c.path)
      .filter((p) => p.startsWith('server/src/main/java/org/acme/fhir/'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(tree.read(file, 'utf-8')).toContain('org.acme.fhir');
    }
  });
});

describe('serverGenerator', () => {
  let tree: Tree;
  const dryRunArgv = '--dry-run';

  beforeEach(() => {
    vi.resetAllMocks();
    tree = createTreeWithEmptyWorkspace();
    process.argv.push(dryRunArgv);
  });

  afterEach(() => {
    const index = process.argv.indexOf(dryRunArgv);
    if (index !== -1) {
      process.argv.splice(index, 1);
    }
  });

  it('rejects an unsupported release', async () => {
    await expect(
      serverGenerator(tree, {
        directory: 'server',
        packageBase: 'org.acme.fhir',
        fhirVersion: FhirVersion.R4,
        release: '1.0.0',
      }),
    ).rejects.toThrow('Unsupported HAPI version: 1.0.0');
  });

  it('prompts for a release when none is provided', async () => {
    select.mockResolvedValueOnce('8.10.0-3');

    await serverGenerator(tree, {
      directory: 'server',
      packageBase: 'org.acme.fhir',
      fhirVersion: FhirVersion.R4,
    });

    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0][0].choices[0]).toBe(
      SUPPORTED_HAPI_VERSIONS[SUPPORTED_HAPI_VERSIONS.length - 1],
    );
    const config = readProjectConfiguration(
      tree,
      'server',
    ) as ServerProjectConfiguration;
    expect(config.hapiReleaseVersion).toBe('8.10.0-3');
  });

  it('registers the project and writes a minimal yaml in dry-run mode', async () => {
    await serverGenerator(tree, {
      directory: 'apps/fhir',
      packageBase: 'org.acme.fhir',
      fhirVersion: FhirVersion.R4B,
      release: '8.10.0-3',
    });

    const config = readProjectConfiguration(
      tree,
      'fhir',
    ) as ServerProjectConfiguration;
    expect(config.root).toBe('apps/fhir');
    expect(config.sourceRoot).toBe('apps/fhir/src');
    expect(config.tags).toContain('nx-fhir-server');
    expect(config.packageBase).toBe('org.acme.fhir');
    expect(config.fhirVersion).toBe(FhirVersion.R4B);
    expect(config.hapiReleaseVersion).toBe('8.10.0-3');

    expect(
      tree.read('apps/fhir/src/main/resources/application.yaml', 'utf-8'),
    ).toContain('hapi.fhir.fhir_version: R4B');
  });
});

describe('downloadAndExtract', () => {
  const extractedDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    while (extractedDirs.length) {
      rmSync(extractedDirs.pop() as string, { recursive: true, force: true });
    }
  });

  it('keeps the starter project files and drops the rest of the repository', async () => {
    stubFetchWithFixture();

    const dir = await downloadAndExtract('8.10.0-3');
    extractedDirs.push(dir);

    expect(readFileSync(join(dir, 'pom.xml'), 'utf-8')).toContain(
      'hapi-fhir-jpaserver-starter',
    );
    expect(existsSync(join(dir, 'Dockerfile'))).toBe(true);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    expect(
      readFileSync(join(dir, 'src/main/resources/application.yaml'), 'utf-8'),
    ).toContain('fhir_version: R4');
    expect(
      existsSync(join(dir, 'src/main/java/ca/uhn/fhir/jpa/starter/Application.java')),
    ).toBe(true);
    expect(existsSync(join(dir, '.github'))).toBe(false);
    expect(existsSync(join(dir, 'charts'))).toBe(false);
  });

  it('fails and cleans up when the release cannot be downloaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(downloadAndExtract('8.10.0-3')).rejects.toThrow(
      'HTTP error! status: 404',
    );
  });

  it('fails when the response carries no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null)));

    await expect(downloadAndExtract('8.10.0-3')).rejects.toThrow(
      'Response body is null',
    );
  });
});

describe('serverGenerator against a starter archive', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    vi.stubEnv('NX_DRY_RUN', '');
    stubFetchWithFixture();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('vendors the starter files, generates the sources and cleans up the download', async () => {
    const infoSpy = vi.spyOn(logger, 'info');

    await serverGenerator(tree, {
      directory: 'apps/fhir-server',
      packageBase: 'org.acme.fhir',
      fhirVersion: FhirVersion.R5,
      release: '8.10.0-3',
    });

    expect(tree.read('apps/fhir-server/pom.xml', 'utf-8')).toContain(
      'hapi-fhir-jpaserver-starter',
    );
    expect(tree.exists('apps/fhir-server/Dockerfile')).toBe(true);
    expect(
      tree.read('apps/fhir-server/src/main/resources/application.yaml', 'utf-8'),
    ).toContain('fhir_version: R5');

    expect(
      tree.read(
        'apps/fhir-server/src/main/java/ca/uhn/fhir/jpa/starter/Application.java',
        'utf-8',
      ),
    ).toContain('public class Application');
    expect(
      tree.read(
        'apps/fhir-server/src/main/java/ca/uhn/fhir/jpa/starter/CustomServerConfig.java',
        'utf-8',
      ),
    ).toContain('org.acme.fhir');
    expect(
      tree
        .listChanges()
        .map((c) => c.path)
        .filter((p) =>
          p.startsWith('apps/fhir-server/src/main/java/org/acme/fhir/'),
        ).length,
    ).toBeGreaterThan(0);

    const config = readProjectConfiguration(
      tree,
      'fhir-server',
    ) as ServerProjectConfiguration;
    expect(config.hapiReleaseVersion).toBe('8.10.0-3');
    expect(
      JSON.parse(tree.read('nx.json', 'utf-8') as string).plugins,
    ).toContain('nx-fhir');

    const extractMessage = infoSpy.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.startsWith('Extracted HAPI FHIR JPA Starter'));
    const tempDir = extractMessage?.split(' to ').pop() as string;
    expect(tempDir).toBeTruthy();
    expect(existsSync(tempDir)).toBe(false);
  });
});
