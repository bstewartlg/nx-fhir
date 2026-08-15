import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  addProjectConfiguration,
  readProjectConfiguration,
  Tree,
} from '@nx/devkit';

const downloadAndExtract = vi.hoisted(() => vi.fn());
vi.mock('../../generators/server/server', () => ({ downloadAndExtract }));

const migrateWithThreeWayMerge = vi.hoisted(() => vi.fn());
const logMigrationSummary = vi.hoisted(() => vi.fn());
vi.mock('../utils/merge', () => ({
  migrateWithThreeWayMerge,
  logMigrationSummary,
}));

const existsSync = vi.hoisted(() => vi.fn());
const rmSync = vi.hoisted(() => vi.fn());
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync,
  rmSync,
}));

import {
  findProjectsToMigrate,
  runHapiMigration,
} from './hapi-migration';
import { MigrationSummary } from '../utils/merge';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';
import { PLUGIN_VERSION } from '../constants/versions';

const { migrateWithThreeWayMerge: actualMigrateWithThreeWayMerge } =
  await vi.importActual<typeof import('../utils/merge')>('../utils/merge');
const { rmSync: actualRmSync, existsSync: actualExistsSync } =
  await vi.importActual<typeof import('fs')>('fs');

const APPLICATION_YAML = 'src/main/resources/application.yaml';

const TESTER_BLOCK = `    tester:
      home:
        name: Local Tester
        fhir_version: R4
`;

const RELEASE_YAML = `hapi:
  fhir:
    fhir_version: R4

${TESTER_BLOCK}
    inline_resource_storage_below_size: 4000
`;

/**
 * The upstream edit that collides with the removal of the tester section: a
 * comment block added directly above it.
 */
const NEXT_RELEASE_YAML = RELEASE_YAML.replace(
  TESTER_BLOCK,
  `    # Remote terminology service
    # remote_terminology_service_url: ~
${TESTER_BLOCK}`,
);

const releaseDirsToRemove: string[] = [];

function createReleaseDirs(contents: { newContent?: string } = {}) {
  const write = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-fhir-release-'));
    releaseDirsToRemove.push(dir);
    mkdirSync(join(dir, 'src/main/resources'), { recursive: true });
    writeFileSync(join(dir, APPLICATION_YAML), content);
    return dir;
  };

  return {
    old: write(RELEASE_YAML),
    new: write(contents.newContent ?? RELEASE_YAML),
  };
}

function summary(overrides: Partial<MigrationSummary> = {}): MigrationSummary {
  return {
    added: 1,
    removed: 0,
    merged: 2,
    conflicts: 0,
    unchanged: 3,
    results: [],
    ...overrides,
  };
}

function addServer(tree: Tree, name: string, hapiReleaseVersion: string) {
  const config: ServerProjectConfiguration = {
    root: name,
    projectType: 'application',
    sourceRoot: `${name}/src`,
    tags: ['nx-fhir-server'],
    packageBase: 'org.acme.fhir',
    fhirVersion: FhirVersion.R4,
    hapiReleaseVersion,
    pluginVersion: '0.0.1',
  };
  addProjectConfiguration(tree, name, config);
}

describe('findProjectsToMigrate', () => {
  it('returns the specific project without scanning versions', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(findProjectsToMigrate(tree, '8.8.0-1', 'chosen')).toEqual([
      'chosen',
    ]);
  });

  it('returns every project recorded at the source version', () => {
    const tree = createTreeWithEmptyWorkspace();
    addServer(tree, 'match-a', '8.8.0-1');
    addServer(tree, 'match-b', '8.8.0-1');
    addServer(tree, 'other', '8.6.0-1');

    expect(findProjectsToMigrate(tree, '8.8.0-1')).toEqual([
      'match-a',
      'match-b',
    ]);
  });
});

describe('runHapiMigration', () => {
  let tree: Tree;

  beforeEach(() => {
    vi.resetAllMocks();
    tree = createTreeWithEmptyWorkspace();
    downloadAndExtract
      .mockResolvedValueOnce('/tmp/old-release')
      .mockResolvedValueOnce('/tmp/new-release');
    migrateWithThreeWayMerge.mockResolvedValue(summary());
    existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    while (releaseDirsToRemove.length > 0) {
      actualRmSync(releaseDirsToRemove.pop() as string, {
        recursive: true,
        force: true,
      });
    }
  });

  it('does nothing when no project matches the source version', async () => {
    addServer(tree, 'server', '8.6.0-1');

    const result = await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(result).toEqual({
      success: true,
      hasConflicts: false,
      projectResults: [],
      skippedProjects: [],
    });
    expect(downloadAndExtract).not.toHaveBeenCalled();
  });

  it('merges each matching project between the downloaded releases', async () => {
    addServer(tree, 'server-a', '8.8.0-1');
    addServer(tree, 'server-b', '8.8.0-1');

    const result = await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(downloadAndExtract).toHaveBeenNthCalledWith(1, '8.8.0-1');
    expect(downloadAndExtract).toHaveBeenNthCalledWith(2, '8.10.0-1');
    expect(migrateWithThreeWayMerge).toHaveBeenCalledTimes(2);
    expect(migrateWithThreeWayMerge).toHaveBeenCalledWith(
      tree,
      'server-a',
      '/tmp/old-release',
      '/tmp/new-release',
      '8.8.0-1',
      '8.10.0-1',
    );
    expect(result.success).toBe(true);
    expect(result.projectResults.map((r) => r.projectName)).toEqual([
      'server-a',
      'server-b',
    ]);
  });

  it('stamps the target version and plugin version on migrated projects', async () => {
    addServer(tree, 'server', '8.8.0-1');

    await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    const config = readProjectConfiguration(
      tree,
      'server',
    ) as ServerProjectConfiguration;
    expect(config.hapiReleaseVersion).toBe('8.10.0-1');
    expect(config.pluginVersion).toBe(PLUGIN_VERSION);
  });

  it('reports conflicts without failing the migration', async () => {
    addServer(tree, 'server', '8.8.0-1');
    migrateWithThreeWayMerge.mockResolvedValue(summary({ conflicts: 2 }));

    const result = await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(result.success).toBe(true);
    expect(result.hasConflicts).toBe(true);
    expect(result.projectResults[0].hasConflicts).toBe(true);
  });

  it('cleans up both temporary directories after a successful run', async () => {
    addServer(tree, 'server', '8.8.0-1');

    await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(rmSync).toHaveBeenCalledWith('/tmp/old-release', {
      recursive: true,
      force: true,
    });
    expect(rmSync).toHaveBeenCalledWith('/tmp/new-release', {
      recursive: true,
      force: true,
    });
  });

  it('rethrows a merge failure and still cleans up', async () => {
    addServer(tree, 'server', '8.8.0-1');
    migrateWithThreeWayMerge.mockRejectedValue(new Error('merge exploded'));

    await expect(
      runHapiMigration(tree, {
        fromVersion: '8.8.0-1',
        toVersion: '8.10.0-1',
      }),
    ).rejects.toThrow('merge exploded');

    expect(rmSync).toHaveBeenCalledWith('/tmp/old-release', {
      recursive: true,
      force: true,
    });
    expect(rmSync).toHaveBeenCalledWith('/tmp/new-release', {
      recursive: true,
      force: true,
    });
  });

  it('reuses the pristine release for a project that kept the tester section', async () => {
    addServer(tree, 'stripped', '8.8.0-1');
    addServer(tree, 'kept', '8.8.0-1');
    tree.write(
      `stripped/${APPLICATION_YAML}`,
      RELEASE_YAML.replace(TESTER_BLOCK, ''),
    );
    tree.write(`kept/${APPLICATION_YAML}`, RELEASE_YAML);

    const releaseYamlAtMergeTime: string[] = [];
    migrateWithThreeWayMerge.mockImplementation(
      async (_tree: Tree, _root: string, oldDir: string) => {
        releaseYamlAtMergeTime.push(
          readFileSync(join(oldDir, APPLICATION_YAML), 'utf-8'),
        );
        return summary();
      },
    );

    const releaseDirs = createReleaseDirs();
    downloadAndExtract
      .mockReset()
      .mockResolvedValueOnce(releaseDirs.old)
      .mockResolvedValueOnce(releaseDirs.new);

    await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(releaseYamlAtMergeTime).toEqual([
      RELEASE_YAML.replace(TESTER_BLOCK, ''),
      RELEASE_YAML,
    ]);
    expect(readFileSync(join(releaseDirs.old, APPLICATION_YAML), 'utf-8')).toBe(
      RELEASE_YAML,
    );
  });

  it('merges a tester-less project against the new comment block without conflict', async () => {
    addServer(tree, 'server', '8.8.0-1');
    tree.write(`server/${APPLICATION_YAML}`, RELEASE_YAML.replace(TESTER_BLOCK, ''));

    const releaseDirs = createReleaseDirs({ newContent: NEXT_RELEASE_YAML });
    downloadAndExtract
      .mockReset()
      .mockResolvedValueOnce(releaseDirs.old)
      .mockResolvedValueOnce(releaseDirs.new);
    migrateWithThreeWayMerge.mockImplementation(actualMigrateWithThreeWayMerge);

    const result = await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(result.hasConflicts).toBe(false);
    const merged = tree.read(`server/${APPLICATION_YAML}`, 'utf-8') as string;
    expect(merged).toContain('# Remote terminology service');
    expect(merged).not.toContain('Local Tester');
    expect(merged).not.toContain('<<<<<<<');
  });

  it('keeps the tester section when the project still has it', async () => {
    addServer(tree, 'server', '8.8.0-1');
    tree.write(`server/${APPLICATION_YAML}`, RELEASE_YAML);

    const releaseDirs = createReleaseDirs({ newContent: NEXT_RELEASE_YAML });
    downloadAndExtract
      .mockReset()
      .mockResolvedValueOnce(releaseDirs.old)
      .mockResolvedValueOnce(releaseDirs.new);
    migrateWithThreeWayMerge.mockImplementation(actualMigrateWithThreeWayMerge);

    const result = await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(result.hasConflicts).toBe(false);
    const merged = tree.read(`server/${APPLICATION_YAML}`, 'utf-8') as string;
    expect(merged).toContain('# Remote terminology service');
    expect(merged).toContain('Local Tester');
  });

  it('leaves docker files owned by a frontend integration out of the merge', async () => {
    // A server imported at the workspace root with the frontend generated
    // directly beneath it: the integration Dockerfile replaced the starter's.
    const serverConfig: ServerProjectConfiguration = {
      root: '.',
      projectType: 'application',
      tags: ['nx-fhir-server'],
      packageBase: 'org.acme.fhir',
      fhirVersion: FhirVersion.R4,
      hapiReleaseVersion: '8.8.0-1',
      pluginVersion: '0.0.1',
    };
    addProjectConfiguration(tree, 'server', serverConfig);
    addProjectConfiguration(tree, 'frontend', {
      root: 'frontend',
      projectType: 'application',
      targets: {
        'copy-to-server': {
          executor: 'nx:run-commands',
          options: {
            commands: ['cpy "dist/**" ".././src/main/resources/static" --cwd=.'],
          },
        },
      },
    });
    tree.write(APPLICATION_YAML, RELEASE_YAML);
    tree.write('Dockerfile', 'FROM combined-frontend-server\n');

    const releaseDirs = createReleaseDirs({ newContent: NEXT_RELEASE_YAML });
    writeFileSync(join(releaseDirs.old, 'Dockerfile'), 'FROM starter:17\n');
    writeFileSync(join(releaseDirs.new, 'Dockerfile'), 'FROM starter:21\n');
    downloadAndExtract
      .mockReset()
      .mockResolvedValueOnce(releaseDirs.old)
      .mockResolvedValueOnce(releaseDirs.new);
    // The strip needs the real filesystem for the release copies, but the
    // run's own temp dir cleanup must stay inert so the release dirs can be
    // inspected after the run.
    existsSync.mockImplementation(actualExistsSync);
    rmSync.mockImplementation((target: string, options: object) => {
      if (String(target).endsWith('Dockerfile')) {
        actualRmSync(target, options);
      }
    });
    migrateWithThreeWayMerge.mockImplementation(actualMigrateWithThreeWayMerge);

    const result = await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(result.hasConflicts).toBe(false);
    expect(tree.read('Dockerfile', 'utf-8')).toBe(
      'FROM combined-frontend-server\n',
    );
    // The release copies are restored for the next project of the run.
    expect(readFileSync(join(releaseDirs.old, 'Dockerfile'), 'utf-8')).toBe(
      'FROM starter:17\n',
    );
    expect(readFileSync(join(releaseDirs.new, 'Dockerfile'), 'utf-8')).toBe(
      'FROM starter:21\n',
    );
  });

  it('still merges the starter docker files for a sibling-level integration', async () => {
    addServer(tree, 'server', '8.8.0-1');
    tree.write(`server/${APPLICATION_YAML}`, RELEASE_YAML);
    tree.write('server/Dockerfile', 'FROM starter:17\n');
    addProjectConfiguration(tree, 'frontend', {
      root: 'frontend',
      projectType: 'application',
      targets: {
        'copy-to-server': {
          executor: 'nx:run-commands',
          options: {
            commands: [
              'cpy "dist/**" "../server/src/main/resources/static" --cwd=.',
            ],
          },
        },
      },
    });

    const releaseDirs = createReleaseDirs();
    writeFileSync(join(releaseDirs.old, 'Dockerfile'), 'FROM starter:17\n');
    writeFileSync(join(releaseDirs.new, 'Dockerfile'), 'FROM starter:21\n');
    downloadAndExtract
      .mockReset()
      .mockResolvedValueOnce(releaseDirs.old)
      .mockResolvedValueOnce(releaseDirs.new);
    migrateWithThreeWayMerge.mockImplementation(actualMigrateWithThreeWayMerge);

    const result = await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
    });

    expect(result.hasConflicts).toBe(false);
    expect(tree.read('server/Dockerfile', 'utf-8')).toBe('FROM starter:21\n');
  });

  it('migrates only the requested project when one is specified', async () => {
    addServer(tree, 'wanted', '8.8.0-1');
    addServer(tree, 'unwanted', '8.8.0-1');

    const result = await runHapiMigration(tree, {
      fromVersion: '8.8.0-1',
      toVersion: '8.10.0-1',
      project: 'wanted',
    });

    expect(migrateWithThreeWayMerge).toHaveBeenCalledTimes(1);
    expect(result.projectResults[0].projectName).toBe('wanted');
  });
});
