import { vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readJson, readProjectConfiguration, Tree } from '@nx/devkit';

const select = vi.hoisted(() => vi.fn());
const input = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ select, input }));

// Default to an unreachable GitHub API so tests stay offline unless a test
// queues a catalog explicitly.
const fetchStarterImageVersions = vi.hoisted(() =>
  vi.fn(async (): Promise<string[] | null> => null),
);
vi.mock('../../shared/utils/hapi-release-discovery', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchStarterImageVersions,
}));

import { importServerGenerator } from './import-server';
import { ImportServerGeneratorSchema } from './schema';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';
import {
  detectExistingServer,
  detectFhirVersionFromYaml,
  detectHapiReleaseCandidates,
} from '../../shared/utils/server-detection';
import { SUPPORTED_HAPI_VERSIONS } from '../../shared/constants/versions';

function pomXml(version: string, revision?: string): string {
  const revisionProperty = revision
    ? `
  <properties>
    <hapi.fhir.jpa.server.starter.revision>${revision}</hapi.fhir.jpa.server.starter.revision>
  </properties>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>ca.uhn.hapi.fhir</groupId>
  <artifactId>hapi-fhir-jpaserver-starter</artifactId>
  <version>\${project.parent.version}-\${hapi.fhir.jpa.server.starter.revision}</version>
  <packaging>war</packaging>${revisionProperty}
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
  opts: {
    version?: string;
    revision?: string;
    fhirVersion?: string;
    packageBase?: string;
  } = {},
) {
  const version = opts.version ?? '8.8.0';
  const fhirVersion = opts.fhirVersion ?? 'R4';
  const packageBase = opts.packageBase ?? 'org.test.server';
  const prefix = root === '.' ? '' : `${root}/`;
  const packageDir = packageBase.replace(/\./g, '/');

  tree.write(`${prefix}pom.xml`, pomXml(version, opts.revision));
  tree.write(
    `${prefix}src/main/resources/application.yaml`,
    applicationYaml(fhirVersion),
  );
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
    expect((config as ServerProjectConfiguration).hapiReleaseVersion).toBe(
      '8.8.0-1',
    );
    expect((config as ServerProjectConfiguration).fhirVersion).toBe('R4');
    expect((config as ServerProjectConfiguration).packageBase).toBe(
      'org.test.server',
    );
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

  it('uses the detected values instead of prompting when there is no terminal', async () => {
    writeFakeServer(tree, 'existing-server', {
      version: '8.8.0',
      fhirVersion: 'R5',
    });

    const originalCi = process.env.CI;
    process.env.CI = 'true';
    try {
      // No release, fhirVersion or packageBase. A prompt here would never
      // resolve, because the wrapping CLI runs the generator with stdin closed.
      await importServerGenerator(tree, {
        directory: 'existing-server',
        name: 'existing-server',
      });
    } finally {
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
    }

    const config = readProjectConfiguration(
      tree,
      'existing-server',
    ) as ServerProjectConfiguration;
    expect(config.hapiReleaseVersion).toBe('8.8.0-1');
    expect(config.fhirVersion).toBe('R5');
    expect(config.packageBase).toBe('org.test.server.common');
  });

  it('falls back to the default package base when custom packages share no meaningful prefix', async () => {
    writeFakeServer(tree, 'existing-server', { packageBase: 'com.acme.fhir' });
    // A second custom package tree disjoint from the first; the only shared
    // prefix would be nothing at all, so detection must not guess.
    tree.write(
      'existing-server/src/main/java/org/example/ops/OpProvider.java',
      'package org.example.ops;\npublic class OpProvider {}\n',
    );

    const originalCi = process.env.CI;
    process.env.CI = 'true';
    try {
      await importServerGenerator(tree, {
        directory: 'existing-server',
        name: 'existing-server',
      });
    } finally {
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
    }

    const config = readProjectConfiguration(
      tree,
      'existing-server',
    ) as ServerProjectConfiguration;
    expect(config.packageBase).toBe('org.custom.server');
  });

  it('records the exact release without a terminal when the pom names its image revision', async () => {
    writeFakeServer(tree, 'revisioned-server', {
      version: '8.10.0',
      revision: '3',
    });

    const originalCi = process.env.CI;
    process.env.CI = 'true';
    try {
      await importServerGenerator(tree, {
        directory: 'revisioned-server',
        name: 'revisioned-server',
      });
    } finally {
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
    }

    const config = readProjectConfiguration(
      tree,
      'revisioned-server',
    ) as ServerProjectConfiguration;
    expect(config.hapiReleaseVersion).toBe('8.10.0-3');
  });

  it('records no release without a terminal when the pom matches several image revisions', async () => {
    writeFakeServer(tree, 'ambiguous-server', { version: '8.10.0' });

    const originalCi = process.env.CI;
    process.env.CI = 'true';
    try {
      await importServerGenerator(tree, {
        directory: 'ambiguous-server',
        name: 'ambiguous-server',
      });
    } finally {
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
    }

    const config = readProjectConfiguration(
      tree,
      'ambiguous-server',
    ) as ServerProjectConfiguration;
    // A recorded guess would become the wrong three-way-merge base later
    expect(config.hapiReleaseVersion).toBeUndefined();
    expect(config.tags).toContain('nx-fhir-server');
  });

  it('records no release without a terminal when the pom matches nothing supported', async () => {
    writeFakeServer(tree, 'unknown-server', { version: '9.9.9' });

    const originalCi = process.env.CI;
    process.env.CI = 'true';
    try {
      await importServerGenerator(tree, {
        directory: 'unknown-server',
        name: 'unknown-server',
      });
    } finally {
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
    }

    const config = readProjectConfiguration(
      tree,
      'unknown-server',
    ) as ServerProjectConfiguration;
    expect(config.hapiReleaseVersion).toBeUndefined();
  });

  it('keeps a previously recorded release when re-importing without one', async () => {
    writeFakeServer(tree, 'srv', { version: '8.10.0' });
    tree.write(
      'srv/project.json',
      JSON.stringify(
        {
          name: 'srv',
          projectType: 'application',
          sourceRoot: 'srv/src',
          hapiReleaseVersion: '8.10.0-2',
        },
        null,
        2,
      ),
    );

    const originalCi = process.env.CI;
    process.env.CI = 'true';
    try {
      await importServerGenerator(tree, { directory: 'srv', name: 'srv' });
    } finally {
      if (originalCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCi;
      }
    }

    expect(readJson(tree, 'srv/project.json').hapiReleaseVersion).toBe(
      '8.10.0-2',
    );
  });

  it('registers a server living at the workspace root with sourceRoot "src"', async () => {
    writeFakeServer(tree, '.', { version: '8.4.0' });

    await importServerGenerator(tree, {
      directory: '.',
      name: 'root-server',
      release: '8.4.0-2',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    });

    const config = readProjectConfiguration(tree, 'root-server');
    expect(config.root).toBe('.');
    expect(config.sourceRoot).toBe('src');
    expect((config as ServerProjectConfiguration).hapiReleaseVersion).toBe(
      '8.4.0-2',
    );
  });

  it('opts the root package.json out of script inference to avoid serve/build/test recursion', async () => {
    writeFakeServer(tree, '.', { version: '8.4.0' });

    await importServerGenerator(tree, {
      directory: '.',
      name: 'root-server',
      release: '8.4.0-2',
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
      release: '8.4.0-2',
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
      expect.arrayContaining([
        'custom-tag',
        'nx-fhir-server',
        'fhir',
        'server',
      ]),
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
    expect((config as ServerProjectConfiguration).packageBase).toContain(
      'org.test.server',
    );
  });

  describe('GitHub release discovery', () => {
    async function asNonInteractive(fn: () => Promise<void>) {
      const originalCi = process.env.CI;
      process.env.CI = 'true';
      try {
        await fn();
      } finally {
        if (originalCi === undefined) {
          delete process.env.CI;
        } else {
          process.env.CI = originalCi;
        }
      }
    }

    it('records a release outside the tested set when GitHub verifies it', async () => {
      writeFakeServer(tree, 'legacy-server', { version: '7.6.0' });
      fetchStarterImageVersions.mockResolvedValueOnce([
        '8.10.0-3',
        '7.6.0',
        '7.4.0',
      ]);

      await asNonInteractive(() =>
        importServerGenerator(tree, {
          directory: 'legacy-server',
          name: 'legacy-server',
        }),
      );

      const config = readProjectConfiguration(
        tree,
        'legacy-server',
      ) as ServerProjectConfiguration;
      expect(config.hapiReleaseVersion).toBe('7.6.0');
    });

    it('records nothing when several published images share the pom base version', async () => {
      writeFakeServer(tree, 'seven-server', { version: '7.6.0' });
      fetchStarterImageVersions.mockResolvedValueOnce([
        '7.6.0',
        '7.6.0-1',
        '7.6.0-2',
      ]);

      await asNonInteractive(() =>
        importServerGenerator(tree, {
          directory: 'seven-server',
          name: 'seven-server',
        }),
      );

      const config = readProjectConfiguration(
        tree,
        'seven-server',
      ) as ServerProjectConfiguration;
      expect(config.hapiReleaseVersion).toBeUndefined();
    });

    it('accepts a provided release outside the tested set when it is published', async () => {
      writeFakeServer(tree, 'pinned-server', { version: '7.6.0' });
      fetchStarterImageVersions.mockResolvedValueOnce(['7.6.0']);

      await asNonInteractive(() =>
        importServerGenerator(tree, {
          directory: 'pinned-server',
          name: 'pinned-server',
          release: '7.6.0',
        }),
      );

      const config = readProjectConfiguration(
        tree,
        'pinned-server',
      ) as ServerProjectConfiguration;
      expect(config.hapiReleaseVersion).toBe('7.6.0');
    });

    it('accepts a provided release inside the tested set without asking GitHub', async () => {
      writeFakeServer(tree, 'curated-server', { version: '8.6.5' });
      fetchStarterImageVersions.mockClear();

      await asNonInteractive(() =>
        importServerGenerator(tree, {
          directory: 'curated-server',
          name: 'curated-server',
          release: '8.6.5-1',
        }),
      );

      const config = readProjectConfiguration(
        tree,
        'curated-server',
      ) as ServerProjectConfiguration;
      expect(config.hapiReleaseVersion).toBe('8.6.5-1');
      expect(fetchStarterImageVersions).not.toHaveBeenCalled();
    });

    it('rejects a provided release that is neither tested nor published', async () => {
      writeFakeServer(tree, 'bad-server');

      await expect(
        asNonInteractive(() =>
          importServerGenerator(tree, {
            directory: 'bad-server',
            name: 'bad-server',
            release: '9.9.9',
          }),
        ),
      ).rejects.toThrow(/Unsupported HAPI version: 9\.9\.9/);
    });
  });

  describe('with a terminal', () => {
    async function asInteractive(fn: () => Promise<void>) {
      const originalIsTTY = process.stdin.isTTY;
      const originalCi = process.env.CI;
      process.stdin.isTTY = true;
      delete process.env.CI;
      try {
        await fn();
      } finally {
        process.stdin.isTTY = originalIsTTY;
        if (originalCi === undefined) {
          delete process.env.CI;
        } else {
          process.env.CI = originalCi;
        }
      }
    }

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('records no release when the leave-unrecorded choice is selected', async () => {
      writeFakeServer(tree, 'old-server', { version: '7.6.0', revision: '1' });
      select.mockResolvedValueOnce(null);

      await asInteractive(() =>
        importServerGenerator(tree, {
          directory: 'old-server',
          name: 'old-server',
        }),
      );

      const config = readProjectConfiguration(
        tree,
        'old-server',
      ) as ServerProjectConfiguration;
      expect(config.hapiReleaseVersion).toBeUndefined();

      const releasePrompt = select.mock.calls[0][0];
      expect(releasePrompt.choices).toContainEqual({
        name: 'None of these (leave unrecorded)',
        value: null,
      });
      expect(releasePrompt.default).toBeNull();
    });

    it('does not discover a release when the pom declares an unreadable revision', async () => {
      writeFakeServer(tree, 'broken-server', {
        version: '8.8.0',
        revision: '${missing.revision}',
      });

      const originalCi = process.env.CI;
      process.env.CI = 'true';
      try {
        await importServerGenerator(tree, {
          directory: 'broken-server',
          name: 'broken-server',
        });
      } finally {
        if (originalCi === undefined) {
          delete process.env.CI;
        } else {
          process.env.CI = originalCi;
        }
      }

      expect(fetchStarterImageVersions).not.toHaveBeenCalled();
      const config = readProjectConfiguration(
        tree,
        'broken-server',
      ) as ServerProjectConfiguration;
      expect(config.hapiReleaseVersion).toBeUndefined();
    });

    it('offers a discovered uncurated release as the default choice', async () => {
      writeFakeServer(tree, 'legacy-server', { version: '7.6.0' });
      fetchStarterImageVersions.mockResolvedValueOnce(['8.10.0-3', '7.6.0']);
      select.mockResolvedValueOnce('7.6.0');

      await asInteractive(() =>
        importServerGenerator(tree, {
          directory: 'legacy-server',
          name: 'legacy-server',
        }),
      );

      const releasePrompt = select.mock.calls[0][0];
      expect(releasePrompt.default).toBe('7.6.0');
      expect(releasePrompt.choices[0].name).toContain('detected from pom.xml');
      expect(releasePrompt.choices[1].value).toBe(
        SUPPORTED_HAPI_VERSIONS[SUPPORTED_HAPI_VERSIONS.length - 1],
      );

      const config = readProjectConfiguration(
        tree,
        'legacy-server',
      ) as ServerProjectConfiguration;
      expect(config.hapiReleaseVersion).toBe('7.6.0');
    });

    it('defaults the release prompt to the release the pom identifies', async () => {
      writeFakeServer(tree, 'revisioned-server', {
        version: '8.10.0',
        revision: '3',
      });
      select.mockResolvedValueOnce('8.10.0-3');

      await asInteractive(() =>
        importServerGenerator(tree, {
          directory: 'revisioned-server',
          name: 'revisioned-server',
        }),
      );

      expect(select.mock.calls[0][0].default).toBe('8.10.0-3');
      const config = readProjectConfiguration(
        tree,
        'revisioned-server',
      ) as ServerProjectConfiguration;
      expect(config.hapiReleaseVersion).toBe('8.10.0-3');
    });
  });
});

describe('server-detection utilities', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('identifies the exact release from the parent version and starter revision', () => {
    expect(detectHapiReleaseCandidates(pomXml('8.10.0', '3'))).toEqual([
      '8.10.0-3',
    ]);
    expect(detectHapiReleaseCandidates(pomXml('8.10.0', '1'))).toEqual([
      '8.10.0-1',
    ]);
    expect(detectHapiReleaseCandidates(pomXml('8.4.0', '2'))).toEqual([
      '8.4.0-2',
    ]);
    expect(detectHapiReleaseCandidates(pomXml('8.4.0', '3'))).toEqual([
      '8.4.0-3',
    ]);
    expect(detectHapiReleaseCandidates(pomXml('8.2.0', '2'))).toEqual([
      '8.2.0-2',
    ]);
    // A revision that names an unsupported image matches nothing
    expect(detectHapiReleaseCandidates(pomXml('8.10.0', '9'))).toEqual([]);
  });

  it('ignores commented-out pom content', () => {
    const decoy = `<!--
  <parent>
    <groupId>ca.uhn.hapi.fhir</groupId>
    <artifactId>hapi-fhir</artifactId>
    <version>7.0.0</version>
  </parent>
  <properties>
    <hapi.fhir.jpa.server.starter.revision>1</hapi.fhir.jpa.server.starter.revision>
  </properties>
-->
`;
    const pom = pomXml('8.10.0', '3').replace('<parent>', `${decoy}<parent>`);

    expect(detectHapiReleaseCandidates(pom)).toEqual(['8.10.0-3']);
  });

  it('falls back to base-version candidates when the revision property is absent', () => {
    expect(detectHapiReleaseCandidates(pomXml('8.8.0'))).toEqual(['8.8.0-1']);
    expect(detectHapiReleaseCandidates(pomXml('8.6.0'))).toEqual(['8.6.0-1']);
    // Without the revision the pom cannot tell image revisions apart
    expect(detectHapiReleaseCandidates(pomXml('8.4.0'))).toEqual([
      '8.4.0-1',
      '8.4.0-2',
      '8.4.0-3',
    ]);
    expect(detectHapiReleaseCandidates(pomXml('8.10.0'))).toEqual([
      '8.10.0-1',
      '8.10.0-2',
      '8.10.0-3',
    ]);
    expect(detectHapiReleaseCandidates(pomXml('8.2.0'))).toEqual([
      '8.2.0-1',
      '8.2.0-2',
    ]);
    expect(detectHapiReleaseCandidates(pomXml('9.9.9'))).toEqual([]);
  });

  it('scans HAPI coordinates for versions when no parent identity exists', () => {
    const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.example</groupId>
  <artifactId>custom-hapi-server</artifactId>
  <properties>
    <some.other.version>1.2.3</some.other.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>appears-first</artifactId>
      <version>8.6.0</version>
    </dependency>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>8.8.0</version>
    </dependency>
  </dependencies>
</project>`;

    expect(detectHapiReleaseCandidates(pom)).toEqual(['8.8.0-1']);
  });

  it('reports no candidates when HAPI dependencies disagree on the version', () => {
    const disagreeingPom = (firstVersion: string, secondVersion: string) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.example</groupId>
  <artifactId>custom-hapi-server</artifactId>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>${firstVersion}</version>
    </dependency>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-jpaserver-base</artifactId>
      <version>${secondVersion}</version>
    </dependency>
  </dependencies>
</project>`;

    expect(detectHapiReleaseCandidates(disagreeingPom('8.6.0', '8.8.0'))).toEqual([]);
    // An untested base still makes the release ambiguous; the tested one
    // must not win by elimination.
    expect(detectHapiReleaseCandidates(disagreeingPom('7.6.0', '8.8.0'))).toEqual([]);
  });

  it('resolves a starter revision referenced through a local property', () => {
    const parentPom = (revision: string, extraProperty = '') => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>ca.uhn.hapi.fhir</groupId>
    <artifactId>hapi-fhir</artifactId>
    <version>8.10.0</version>
  </parent>
  <artifactId>custom-hapi-server</artifactId>
  <properties>
    <hapi.fhir.jpa.server.starter.revision>${revision}</hapi.fhir.jpa.server.starter.revision>${extraProperty}
  </properties>
</project>`;

    // A resolvable property names the image exactly.
    expect(
      detectHapiReleaseCandidates(
        parentPom('${starter.revision}', '\n    <starter.revision>3</starter.revision>'),
      ),
    ).toEqual(['8.10.0-3']);
    // An unreadable revision names an unknown image; the base alone must
    // not produce a candidate.
    expect(
      detectHapiReleaseCandidates(parentPom('${missing.revision}')),
    ).toEqual([]);
  });

  it('reports no candidates when a HAPI dependency has no version of its own', () => {
    const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.example</groupId>
  <artifactId>custom-hapi-server</artifactId>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
    </dependency>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-jpaserver-base</artifactId>
      <version>8.8.0</version>
    </dependency>
  </dependencies>
</project>`;

    // The versionless dependency is managed elsewhere and could disagree
    // with the explicit 8.8.0.
    expect(detectHapiReleaseCandidates(pom)).toEqual([]);
  });

  it('ignores versionless HAPI coordinates inside exclusions', () => {
    const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.example</groupId>
  <artifactId>custom-hapi-server</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>some-library</artifactId>
      <version>1.0.0</version>
      <exclusions>
        <exclusion>
          <groupId>ca.uhn.hapi.fhir</groupId>
          <artifactId>hapi-fhir-base</artifactId>
        </exclusion>
      </exclusions>
    </dependency>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-jpaserver-base</artifactId>
      <version>8.8.0</version>
    </dependency>
  </dependencies>
</project>`;

    // Exclusions never carry versions and must not make the release
    // ambiguous.
    expect(detectHapiReleaseCandidates(pom)).toEqual(['8.8.0-1']);
  });

  it('resolves HAPI versions referenced through local properties', () => {
    const propertyPom = (property: string, dependencyVersion: string, secondVersion?: string) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.example</groupId>
  <artifactId>custom-hapi-server</artifactId>
  <properties>
    <hapi.version>${property}</hapi.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>${dependencyVersion}</version>
    </dependency>${
      secondVersion
        ? `
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-jpaserver-base</artifactId>
      <version>${secondVersion}</version>
    </dependency>`
        : ''
    }
  </dependencies>
</project>`;

    // A resolvable property behaves like the version it names.
    expect(
      detectHapiReleaseCandidates(propertyPom('8.8.0', '${hapi.version}')),
    ).toEqual(['8.8.0-1']);
    // A property resolving to a different base is a disagreement.
    expect(
      detectHapiReleaseCandidates(
        propertyPom('7.6.0', '${hapi.version}', '8.8.0'),
      ),
    ).toEqual([]);
    // An unresolvable version could hide a disagreement, so nothing matches.
    expect(
      detectHapiReleaseCandidates(
        propertyPom('8.8.0', '${missing.version}', '8.8.0'),
      ),
    ).toEqual([]);
  });

  it('ignores the version of a non-HAPI parent', () => {
    const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.example</groupId>
  <artifactId>custom-hapi-server</artifactId>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>8.6.0</version>
  </parent>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>8.8.0</version>
    </dependency>
  </dependencies>
</project>`;

    expect(detectHapiReleaseCandidates(pom)).toEqual(['8.8.0-1']);
  });

  it('does not let an unrelated dependency version override the parent identity', () => {
    const dependency = `<dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>unrelated</artifactId>
      <version>8.10.0</version>
    </dependency>
  </dependencies>
  `;
    const pom = pomXml('7.6.0').replace('<parent>', `${dependency}<parent>`);

    expect(detectHapiReleaseCandidates(pom)).toEqual([]);
  });

  it('reads the FHIR version from application.yaml', () => {
    expect(detectFhirVersionFromYaml(applicationYaml('R5'))).toBe(
      FhirVersion.R5,
    );
    expect(detectFhirVersionFromYaml('spring:\n  main: {}\n')).toBeUndefined();
  });

  it('returns null when pom.xml lacks a HAPI marker', () => {
    tree.write(
      'plain/pom.xml',
      '<project><artifactId>not-hapi</artifactId></project>',
    );
    tree.write(
      'plain/src/main/resources/application.yaml',
      'spring:\n  main: {}\n',
    );
    expect(detectExistingServer(tree, 'plain')).toBeNull();
  });

  it('detects a full server and its metadata', () => {
    writeFakeServer(tree, 'srv', { version: '8.8.0', fhirVersion: 'R4' });
    const detected = detectExistingServer(tree, 'srv');
    expect(detected).not.toBeNull();
    expect(detected?.root).toBe('srv');
    expect(detected?.fhirVersion).toBe(FhirVersion.R4);
    expect(detected?.hapiReleaseVersion).toBe('8.8.0-1');
    expect(detected?.hapiReleaseCandidates).toEqual(['8.8.0-1']);
    expect(detected?.packageBase).toBe('org.test.server.common');
  });

  it('reports no single release when the pom matches several image revisions', () => {
    writeFakeServer(tree, 'srv', { version: '8.10.0' });
    const detected = detectExistingServer(tree, 'srv');
    expect(detected?.hapiReleaseVersion).toBeUndefined();
    expect(detected?.hapiReleaseCandidates).toEqual([
      '8.10.0-1',
      '8.10.0-2',
      '8.10.0-3',
    ]);
  });
});
