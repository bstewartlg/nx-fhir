import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  ProjectConfiguration,
  Tree,
  addProjectConfiguration,
  logger,
} from '@nx/devkit';

import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';
import { PLUGIN_VERSION } from '../../shared/constants/versions';
import { getReachableVersions } from '../../shared/migration/hapi-migration-resolver';

const isInteractive = vi.hoisted(() => vi.fn(() => false));
const runHapiMigration = vi.hoisted(() =>
  vi.fn(async () => ({
    success: true,
    hasConflicts: false,
    projectResults: [],
    skippedProjects: [],
  })),
);
const select = vi.hoisted(() => vi.fn());
const ensureGitRepositoryClean = vi.hoisted(() => vi.fn());
const getUncommittedFiles = vi.hoisted(() => vi.fn((): string[] => []));

vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

// Published starter tags, trimmed to the versions these tests resolve against.
const PUBLISHED_IMAGES = [
  '7.4.0',
  '7.6.0',
  '8.4.0-1',
  '8.4.0-2',
  '8.4.0-3',
  '8.6.5-1',
  '8.10.0-3',
];
const fetchStarterImageVersions = vi.hoisted(() => vi.fn());
vi.mock('../../shared/utils/hapi-release-discovery', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchStarterImageVersions,
}));
vi.mock('../../shared/migration/hapi-migration', () => ({ runHapiMigration }));
vi.mock('@inquirer/prompts', () => ({ select }));
vi.mock('../../shared/utils/git', () => ({
  ensureGitRepositoryClean,
  getUncommittedFiles,
}));

import { runMigrationStep, updateServerGenerator } from './update-server';

const projectName = 'test';
const SKIP = '__skip__';

/** A release outside the tested migration graph, which bridges to 8.0.0. */
const UNTESTED_RELEASE = '7.6.0';

const CONFLICT_RESULT = {
  success: true,
  hasConflicts: true,
  projectResults: [],
  skippedProjects: [],
};

function createTreeWithServer(hapiReleaseVersion: string): Tree {
  const tree = createTreeWithEmptyWorkspace();
  const serverProjectConfig: ServerProjectConfiguration = {
    root: projectName,
    projectType: 'application',
    packageBase: 'com.example',
    sourceRoot: `${projectName}/src`,
    tags: ['nx-fhir-server'],
    hapiReleaseVersion,
    fhirVersion: FhirVersion.R4,
    pluginVersion: PLUGIN_VERSION,
  };
  addProjectConfiguration(tree, projectName, serverProjectConfig);
  tree.write(`${projectName}/pom.xml`, '<project></project>');
  return tree;
}

function resetMocks() {
  vi.clearAllMocks();
  fetchStarterImageVersions.mockResolvedValue(PUBLISHED_IMAGES);
  isInteractive.mockReturnValue(false);
  ensureGitRepositoryClean.mockImplementation(() => undefined);
  getUncommittedFiles.mockImplementation(() => []);
  runHapiMigration.mockResolvedValue({
    success: true,
    hasConflicts: false,
    projectResults: [],
    skippedProjects: [],
  });
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
}

describe('update-server generator', () => {
  let tree: Tree;

  beforeEach(() => {
    vi.clearAllMocks();
    isInteractive.mockReturnValue(false);
    runHapiMigration.mockResolvedValue({
      success: true,
      hasConflicts: false,
      projectResults: [],
      skippedProjects: [],
    });
    tree = createTreeWithServer('8.8.0-1');
  });

  describe('without a terminal', () => {
    it('uses the only server project instead of prompting for one', async () => {
      await updateServerGenerator(tree, {
        fromNxMigrate: true,
        targetVersion: '8.10.0-3',
      });

      expect(select).not.toHaveBeenCalled();
      expect(runHapiMigration.mock.calls.map(([, o]) => o.toVersion)).toEqual([
        '8.10.0-1',
        '8.10.0-2',
        '8.10.0-3',
      ]);
    });

    it('skips the update from nx migrate instead of guessing between several projects', async () => {
      addProjectConfiguration(tree, 'second-server', {
        root: 'second-server',
        projectType: 'application',
        packageBase: 'com.example.second',
        sourceRoot: 'second-server/src',
        tags: ['nx-fhir-server'],
        hapiReleaseVersion: '8.8.0-1',
        fhirVersion: FhirVersion.R4,
        pluginVersion: PLUGIN_VERSION,
      } as ServerProjectConfiguration);
      tree.write('second-server/pom.xml', '<project></project>');

      await updateServerGenerator(tree, { fromNxMigrate: true });

      expect(select).not.toHaveBeenCalled();
      expect(runHapiMigration).not.toHaveBeenCalled();
    });

    it('skips the update instead of choosing a target version on its own', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      await updateServerGenerator(tree, {
        project: projectName,
        fromNxMigrate: true,
      });

      expect(select).not.toHaveBeenCalled();
      expect(runHapiMigration).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping the server update'),
      );
      warn.mockRestore();
    });

    it('pauses the chain after a conflict', async () => {
      runHapiMigration.mockResolvedValueOnce({
        success: true,
        hasConflicts: true,
        projectResults: [],
        skippedProjects: [],
      });

      await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.10.0-3',
        fromNxMigrate: true,
      });

      expect(runHapiMigration).toHaveBeenCalledTimes(1);
    });
  });

  describe('with a terminal', () => {
    beforeEach(() => {
      isInteractive.mockReturnValue(true);
    });

    it('prompts for the target version', async () => {
      select.mockResolvedValue('8.10.0-1');

      await updateServerGenerator(tree, {
        project: projectName,
        fromNxMigrate: true,
      });

      expect(select).toHaveBeenCalledTimes(1);
      const prompt = select.mock.calls[0][0];
      expect(prompt.message).toContain('to which release?');
      const reachable = getReachableVersions('8.8.0-1');
      expect(prompt.choices[0].value).toBe(reachable[reachable.length - 1]);
      expect(prompt.choices[prompt.choices.length - 1].name).toBe('Skip');
      expect(runHapiMigration.mock.calls.map(([, o]) => o.toVersion)).toEqual([
        '8.10.0-1',
      ]);
    });

    it('stops after a conflict without asking to continue', async () => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      runHapiMigration.mockResolvedValueOnce(CONFLICT_RESULT);

      await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.10.0-3',
        fromNxMigrate: true,
      });

      expect(select).not.toHaveBeenCalled();
      expect(runHapiMigration).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('Migration chain paused'),
      );
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('is now at version 8.10.0-1'),
      );
      info.mockRestore();
    });

    it('runs every step when no step reports a conflict', async () => {
      await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.10.0-3',
        fromNxMigrate: true,
      });

      expect(runHapiMigration.mock.calls.map(([, o]) => o.toVersion)).toEqual([
        '8.10.0-1',
        '8.10.0-2',
        '8.10.0-3',
      ]);
    });
  });

  describe('releases outside the migration graph', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('warns before running a bridge step', async () => {
      const bridgeTree = createTreeWithServer(UNTESTED_RELEASE);

      await updateServerGenerator(bridgeTree, {
        project: projectName,
        targetVersion: '8.0.0',
        fromNxMigrate: true,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('outside the tested migration set'),
      );
      expect(runHapiMigration.mock.calls.map(([, o]) => o)).toEqual([
        {
          fromVersion: UNTESTED_RELEASE,
          toVersion: '8.0.0',
          project: projectName,
        },
      ]);
    });

    it('runs no migration when an untested release is already at the target version', async () => {
      const bridgeTree = createTreeWithServer(UNTESTED_RELEASE);

      await updateServerGenerator(bridgeTree, {
        project: projectName,
        targetVersion: UNTESTED_RELEASE,
      });

      expect(runHapiMigration).not.toHaveBeenCalled();
    });

    it('marks the bridge step in the migration path summary', async () => {
      const bridgeTree = createTreeWithServer(UNTESTED_RELEASE);

      await updateServerGenerator(bridgeTree, {
        project: projectName,
        fromNxMigrate: true,
        targetVersion: '8.10.0-3',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          `1. ${UNTESTED_RELEASE} → 8.0.0 (untested bridge)`,
        ),
      );
      expect(runHapiMigration.mock.calls.map(([, o]) => o.toVersion)).toEqual([
        '8.0.0',
        '8.0.0-1',
        '8.0.0-2',
        '8.2.0-1',
        '8.2.0-2',
        '8.4.0-1',
        '8.4.0-2',
        '8.4.0-3',
        '8.6.0-1',
        '8.6.5-1',
        '8.8.0-1',
        '8.10.0-1',
        '8.10.0-2',
        '8.10.0-3',
      ]);
    });
  });

  describe('git repository check', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('passes the force flag to the git check', async () => {
      await updateServerGenerator(tree, { project: projectName, force: true });

      expect(ensureGitRepositoryClean).toHaveBeenCalledWith(tree.root, true);
    });

    it('lists the uncommitted files and rethrows when the repository is dirty', async () => {
      ensureGitRepositoryClean.mockImplementationOnce(() => {
        throw new Error('Git repository has uncommitted changes.');
      });
      getUncommittedFiles.mockImplementationOnce(() =>
        Array.from({ length: 12 }, (unused, index) => `file-${index}.ts`),
      );

      await expect(
        updateServerGenerator(tree, { project: projectName }),
      ).rejects.toThrow('uncommitted changes');

      expect(logger.error).toHaveBeenCalledWith('  - file-0.ts');
      expect(logger.error).toHaveBeenCalledWith('  ... and 2 more');
      expect(runHapiMigration).not.toHaveBeenCalled();
    });
  });

  describe('project selection', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('does not mistake a plain Maven application for a server', async () => {
      const mavenTree = createTreeWithEmptyWorkspace();
      addProjectConfiguration(mavenTree, 'plain-maven', {
        root: 'plain-maven',
        projectType: 'application',
      });
      mavenTree.write('plain-maven/pom.xml', '<project></project>');

      await expect(updateServerGenerator(mavenTree, {})).rejects.toThrow(
        'No FHIR server projects found in the workspace',
      );
      expect(runHapiMigration).not.toHaveBeenCalled();
    });

    it('throws when the workspace has no server projects', async () => {
      const emptyTree = createTreeWithEmptyWorkspace();

      await expect(updateServerGenerator(emptyTree, {})).rejects.toThrow(
        'No FHIR server projects found in the workspace',
      );
    });

    it('finds an untagged project by the server fingerprint', async () => {
      const untaggedTree = createTreeWithEmptyWorkspace();
      addProjectConfiguration(untaggedTree, 'untagged', {
        root: 'untagged',
        projectType: 'application',
        sourceRoot: 'untagged/src',
        hapiReleaseVersion: '8.8.0-1',
        fhirVersion: FhirVersion.R4,
      } as ProjectConfiguration);
      untaggedTree.write('untagged/pom.xml', '<project/>');

      await updateServerGenerator(untaggedTree, { targetVersion: '8.10.0-3' });

      expect(runHapiMigration.mock.calls.map(([, o]) => o.project)).toEqual([
        'untagged',
        'untagged',
        'untagged',
      ]);
    });

    it('throws outside nx migrate when several projects exist and there is no terminal', async () => {
      addProjectConfiguration(tree, 'second-server', {
        root: 'second-server',
        projectType: 'application',
        packageBase: 'com.example.second',
        sourceRoot: 'second-server/src',
        tags: ['nx-fhir-server'],
        hapiReleaseVersion: '8.8.0-1',
        fhirVersion: FhirVersion.R4,
        pluginVersion: PLUGIN_VERSION,
      } as ServerProjectConfiguration);
      tree.write('second-server/pom.xml', '<project></project>');

      await expect(updateServerGenerator(tree, {})).rejects.toThrow(
        `Pass --project with one of: ${projectName}, second-server`,
      );
    });

    it('prompts for the project when a terminal is available', async () => {
      isInteractive.mockReturnValue(true);
      select
        .mockResolvedValueOnce(projectName)
        .mockResolvedValueOnce('8.10.0-1');

      await updateServerGenerator(tree, {});

      expect(select).toHaveBeenCalledTimes(2);
      expect(runHapiMigration.mock.calls.map(([, o]) => o.project)).toEqual([
        projectName,
      ]);
    });

    it('throws when the project prompt returns nothing', async () => {
      isInteractive.mockReturnValue(true);
      select.mockResolvedValue(undefined);

      await expect(updateServerGenerator(tree, {})).rejects.toThrow(
        'No project selected',
      );
    });
  });

  describe('project configuration', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('throws when the named project is not in the workspace', async () => {
      await expect(
        updateServerGenerator(tree, { project: 'missing' }),
      ).rejects.toThrow('Project configuration for missing not found');
    });

    it('throws when the project has no hapiReleaseVersion', async () => {
      const importedTree = createTreeWithEmptyWorkspace();
      addProjectConfiguration(importedTree, 'imported', {
        root: 'imported',
        projectType: 'application',
        sourceRoot: 'imported/src',
        tags: ['nx-fhir-server'],
      } as ProjectConfiguration);

      await expect(
        updateServerGenerator(importedTree, { project: 'imported' }),
      ).rejects.toThrow('does not have a hapiReleaseVersion configured');
    });
  });

  describe('target version', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('throws when no newer version is reachable', async () => {
      const latestTree = createTreeWithServer('8.10.0-3');

      await expect(
        updateServerGenerator(latestTree, { project: projectName }),
      ).rejects.toThrow('No migration path available from HAPI FHIR version');
    });

    it('runs no migration when Skip is selected', async () => {
      isInteractive.mockReturnValue(true);
      select.mockResolvedValue(SKIP);

      await updateServerGenerator(tree, { project: projectName });

      expect(runHapiMigration).not.toHaveBeenCalled();
    });

    it('throws when the requested target version has no migration path', async () => {
      await expect(
        updateServerGenerator(tree, {
          project: projectName,
          targetVersion: '9.0.0',
        }),
      ).rejects.toThrow('Cannot migrate from 8.8.0-1 to 9.0.0');
    });

    it('runs no migration when the project is already at the target version', async () => {
      await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.8.0-1',
      });

      expect(runHapiMigration).not.toHaveBeenCalled();
    });
  });

  describe('migration results', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('throws when a migration step fails', async () => {
      runHapiMigration.mockResolvedValueOnce({
        success: false,
        hasConflicts: false,
        projectResults: [],
        skippedProjects: [],
      });

      await expect(
        updateServerGenerator(tree, {
          project: projectName,
          targetVersion: '8.10.0-1',
        }),
      ).rejects.toThrow('Migration 8.8.0-1 → 8.10.0-1 failed');
    });

    it('reports success when the last step leaves no markers behind', async () => {
      runHapiMigration.mockResolvedValue(CONFLICT_RESULT);

      await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.10.0-1',
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(`Successfully updated ${projectName}`),
      );
    });

    it('warns instead of reporting success when the last step leaves markers', async () => {
      const conflictedFile = `${projectName}/src/main/resources/application.yaml`;
      runHapiMigration.mockImplementationOnce(async () => {
        tree.write(
          conflictedFile,
          'hapi:\n<<<<<<< CURRENT (Your changes)\n=======\n>>>>>>> NEW\n',
        );
        return CONFLICT_RESULT;
      });

      const callback = await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.10.0-1',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('but conflicts need manual resolution'),
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Successfully updated'),
      );

      vi.mocked(logger.warn).mockClear();
      await callback?.();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `${projectName} is at HAPI FHIR 8.10.0-1 with unresolved conflicts`,
        ),
      );
      expect(logger.warn).toHaveBeenCalledWith(`  - ${conflictedFile}`);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('step(s) remaining'),
      );
    });
  });

  describe('outcome callback', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    const conflictedFile = `${projectName}/src/main/resources/application.yaml`;

    it('reports the completed update', async () => {
      const callback = await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.10.0-1',
      });

      expect(typeof callback).toBe('function');
      vi.mocked(logger.info).mockClear();
      await callback?.();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(`${projectName} updated to HAPI FHIR 8.10.0-1`),
      );
    });

    it('reports the pause, the conflicted files and the remaining steps', async () => {
      runHapiMigration.mockImplementationOnce(async () => {
        tree.write(
          conflictedFile,
          'hapi:\n<<<<<<< CURRENT (Your changes)\n=======\n>>>>>>> NEW\n',
        );
        return CONFLICT_RESULT;
      });

      const callback = await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.10.0-3',
      });

      expect(typeof callback).toBe('function');
      vi.mocked(logger.warn).mockClear();
      await callback?.();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `Migration chain paused: ${projectName} is at HAPI FHIR 8.10.0-1`,
        ),
      );
      expect(logger.warn).toHaveBeenCalledWith(`  - ${conflictedFile}`);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('2 step(s) remaining'),
      );
    });

    it('returns nothing when no migration step runs', async () => {
      select.mockResolvedValue(SKIP);
      isInteractive.mockReturnValue(true);

      await expect(
        updateServerGenerator(tree, { project: projectName }),
      ).resolves.toBeUndefined();
      expect(runHapiMigration).not.toHaveBeenCalled();
    });
  });

  describe('unresolved conflict markers', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    const conflictedFile = `${projectName}/src/main/resources/application.yaml`;
    const conflictedContent = `hapi:
  fhir:
<<<<<<< CURRENT (Your changes)
    fhir_version: R4
||||||| BASE
    fhir_version: R4B
=======
    fhir_version: R5
>>>>>>> NEW
`;

    it('throws before running any migration step', async () => {
      tree.write(conflictedFile, conflictedContent);

      await expect(
        updateServerGenerator(tree, {
          project: projectName,
          targetVersion: '8.10.0-1',
        }),
      ).rejects.toThrow('unresolved merge conflict markers');

      expect(runHapiMigration).not.toHaveBeenCalled();
    });

    it('lists the files holding the markers', async () => {
      tree.write(conflictedFile, conflictedContent);

      await expect(
        updateServerGenerator(tree, {
          project: projectName,
          targetVersion: '8.10.0-1',
        }),
      ).rejects.toThrow();

      expect(logger.error).toHaveBeenCalledWith(`  - ${conflictedFile}`);
    });

    it('runs the migration when the marker text is not at the start of a line', async () => {
      tree.write(
        conflictedFile,
        'hapi:\n  fhir:\n    note: "<<<<<<< CURRENT (Your changes)"\n',
      );

      await updateServerGenerator(tree, {
        project: projectName,
        targetVersion: '8.10.0-1',
      });

      expect(runHapiMigration).toHaveBeenCalledTimes(1);
    });
  });

  describe('unresolvable recorded releases', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('auto-matches a bare base version that names exactly one published release', async () => {
      const bareTree = createTreeWithServer('8.6.5');

      await updateServerGenerator(bareTree, {
        project: projectName,
        targetVersion: '8.8.0-1',
        fromNxMigrate: true,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('matches the published release 8.6.5-1'),
      );
      expect(runHapiMigration.mock.calls.map(([, o]) => o.fromVersion)).toEqual([
        '8.6.5-1',
      ]);
    });

    it('keeps an exact published tag and bridges from it', async () => {
      const exactTree = createTreeWithServer('7.6.0');

      await updateServerGenerator(exactTree, {
        project: projectName,
        targetVersion: '8.0.0',
        fromNxMigrate: true,
      });

      expect(runHapiMigration.mock.calls.map(([, o]) => o)).toEqual([
        { fromVersion: '7.6.0', toVersion: '8.0.0', project: projectName },
      ]);
    });

    it('prompts for the real release when the recorded base is ambiguous', async () => {
      isInteractive.mockReturnValue(true);
      select.mockResolvedValueOnce('8.4.0-2');
      const ambiguousTree = createTreeWithServer('8.4.0');

      await updateServerGenerator(ambiguousTree, {
        project: projectName,
        targetVersion: '8.4.0-3',
        fromNxMigrate: true,
      });

      const prompt = select.mock.calls[0][0];
      expect(prompt.message).toContain(
        'does not correspond to a published starter release',
      );
      // The published revisions of the recorded base lead the list.
      expect(prompt.choices.slice(0, 3).map((c: { value: string }) => c.value)).toEqual([
        '8.4.0-1',
        '8.4.0-2',
        '8.4.0-3',
      ]);
      expect(runHapiMigration.mock.calls.map(([, o]) => o.fromVersion)).toEqual([
        '8.4.0-2',
      ]);
    });

    it('warns with the fix and skips an ambiguous release without a terminal', async () => {
      const ambiguousTree = createTreeWithServer('8.4.0');

      await updateServerGenerator(ambiguousTree, {
        project: projectName,
        targetVersion: '8.4.0-3',
        fromNxMigrate: true,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Set hapiReleaseVersion in its project.json'),
      );
      expect(runHapiMigration).not.toHaveBeenCalled();
    });

    it('treats an unreachable catalog as unresolvable', async () => {
      fetchStarterImageVersions.mockResolvedValue(null);
      const bareTree = createTreeWithServer('8.6.5');

      await updateServerGenerator(bareTree, {
        project: projectName,
        targetVersion: '8.8.0-1',
        fromNxMigrate: true,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'does not correspond to a published starter release',
        ),
      );
      expect(runHapiMigration).not.toHaveBeenCalled();
    });
  });

  describe('runMigrationStep', () => {
    beforeEach(resetMocks);

    it('runs the generic three-way merge for a step with no implementation', async () => {
      const stepTree = createTreeWithEmptyWorkspace();

      const result = await runMigrationStep(
        stepTree,
        { from: '8.8.0-1', to: '8.10.0-1' },
        projectName,
      );

      expect(result).toEqual({
        success: true,
        hasConflicts: false,
        projectResults: [],
        skippedProjects: [],
      });
      expect(runHapiMigration).toHaveBeenCalledWith(stepTree, {
        fromVersion: '8.8.0-1',
        toVersion: '8.10.0-1',
        project: projectName,
      });
    });

    it('runs the named module instead for a step with an implementation', async () => {
      const stepTree = createTreeWithEmptyWorkspace();

      const result = await runMigrationStep(
        stepTree,
        {
          from: '8.8.0-1',
          to: '8.10.0-1',
          implementation: 'shared/migration/custom-step-example',
        },
        projectName,
      );

      expect(result).toEqual({
        success: true,
        hasConflicts: false,
        projectResults: [],
        skippedProjects: [],
      });
      expect(runHapiMigration).not.toHaveBeenCalled();
      expect(stepTree.read('.nx-fhir-custom-step', 'utf-8')).toContain(
        projectName,
      );
    });
  });
});
