import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  ProjectConfiguration,
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';

import { FrontendProjectConfiguration } from '../../shared/models';
import { PLUGIN_VERSION } from '../../shared/constants/versions';
import { CURRENT_FRONTEND_VERSION } from '../../shared/migration/frontend-migration-resolver';

const isInteractive = vi.hoisted(() => vi.fn(() => false));
const runFrontendMigration = vi.hoisted(() =>
  vi.fn(async () => ({
    success: true,
    hasConflicts: false,
    projectResults: [],
    skippedProjects: [],
  }))
);
const select = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const ensureGitRepositoryClean = vi.hoisted(() => vi.fn());
const getUncommittedFiles = vi.hoisted(() => vi.fn((): string[] => []));

vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));
vi.mock('../../shared/migration/frontend-migration', () => ({
  runFrontendMigration,
}));
vi.mock('@inquirer/prompts', () => ({ select, confirm }));
vi.mock('../../shared/utils/git', () => ({
  ensureGitRepositoryClean,
  getUncommittedFiles,
}));

const SKIP = '__skip__';

function addFrontendProject(
  tree: Tree,
  name: string,
  overrides: Partial<FrontendProjectConfiguration> = {},
) {
  addProjectConfiguration(tree, name, {
    root: name,
    projectType: 'application',
    sourceRoot: `${name}/src`,
    tags: ['nx-fhir-frontend'],
    frontendVersion: '0.2.0',
    frontendTemplate: 'browser',
    pluginVersion: PLUGIN_VERSION,
    ...overrides,
  } as FrontendProjectConfiguration);
}

function createWorkspace(names: string[] = ['app-one']): Tree {
  const workspace = createTreeWithEmptyWorkspace();
  names.forEach((name) => addFrontendProject(workspace, name));
  return workspace;
}

function resetMocks() {
  vi.clearAllMocks();
  isInteractive.mockReturnValue(false);
  ensureGitRepositoryClean.mockImplementation(() => undefined);
  getUncommittedFiles.mockImplementation(() => []);
  runFrontendMigration.mockResolvedValue({
    success: true,
    hasConflicts: false,
    projectResults: [],
    skippedProjects: [],
  });
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
}

describe('update-frontend generator', () => {
  let tree: Tree;

  beforeAll(() => {
    tree = createTreeWithEmptyWorkspace();
    const frontendProjectConfig: FrontendProjectConfiguration = {
      root: 'my-frontend',
      projectType: 'application',
      sourceRoot: 'my-frontend/src',
      tags: ['nx-fhir-frontend', 'fhir', 'frontend', 'client'],
      frontendVersion: '0.2.0',
      frontendTemplate: 'browser',
      pluginVersion: PLUGIN_VERSION
    }
    addProjectConfiguration(tree, 'my-frontend', frontendProjectConfig);
  });

  it('should have a valid project configuration', () => {
    const config = readProjectConfiguration(tree, 'my-frontend') as FrontendProjectConfiguration;
    expect(config).toBeDefined();
    expect(config.frontendVersion).toBe('0.2.0');
    expect(config.frontendTemplate).toBe('browser');
    expect(config.tags).toContain('nx-fhir-frontend');
  });

  it('should detect frontend projects by tag', () => {
    const config = readProjectConfiguration(tree, 'my-frontend');
    expect(config.tags).toContain('nx-fhir-frontend');
  });

  describe('without a terminal', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      isInteractive.mockReturnValue(false);
      runFrontendMigration.mockResolvedValue({
        success: true,
        hasConflicts: false,
        projectResults: [],
        skippedProjects: [],
      });
    });

    it('uses the only frontend project instead of prompting for one', async () => {
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(tree, {
        fromNxMigrate: true,
        targetVersion: CURRENT_FRONTEND_VERSION,
      });

      expect(select).not.toHaveBeenCalled();
      expect(
        runFrontendMigration.mock.calls.map(([, o]) => o.project)
      ).toEqual(['my-frontend']);
    });

    it('skips the update instead of choosing a target version on its own', async () => {
      const { updateFrontendGenerator } = await import('./update-frontend');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      await updateFrontendGenerator(tree, {
        project: 'my-frontend',
        fromNxMigrate: true,
      });

      expect(select).not.toHaveBeenCalled();
      expect(runFrontendMigration).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping the frontend update'),
      );
      warn.mockRestore();
    });
  });

  describe('git repository check', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('passes the force flag to the git check', async () => {
      const workspace = createWorkspace();
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(workspace, {
        project: 'app-one',
        force: true,
      });

      expect(ensureGitRepositoryClean).toHaveBeenCalledWith(
        workspace.root,
        true,
      );
    });

    it('lists the uncommitted files and rethrows when the repository is dirty', async () => {
      const workspace = createWorkspace();
      ensureGitRepositoryClean.mockImplementationOnce(() => {
        throw new Error('Git repository has uncommitted changes.');
      });
      getUncommittedFiles.mockImplementationOnce(() =>
        Array.from({ length: 12 }, (unused, index) => `file-${index}.ts`),
      );
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(
        updateFrontendGenerator(workspace, { project: 'app-one' }),
      ).rejects.toThrow('uncommitted changes');

      expect(logger.error).toHaveBeenCalledWith('  - file-0.ts');
      expect(logger.error).toHaveBeenCalledWith('  ... and 2 more');
      expect(runFrontendMigration).not.toHaveBeenCalled();
    });
  });

  describe('project selection', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('throws when the workspace has no frontend projects', async () => {
      const workspace = createTreeWithEmptyWorkspace();
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(updateFrontendGenerator(workspace, {})).rejects.toThrow(
        'No FHIR frontend projects found in the workspace',
      );
    });

    it('finds a project by frontendVersion when the tag is missing', async () => {
      const workspace = createTreeWithEmptyWorkspace();
      addFrontendProject(workspace, 'untagged', { tags: [] });
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(workspace, {
        targetVersion: CURRENT_FRONTEND_VERSION,
      });

      expect(
        runFrontendMigration.mock.calls.map(([, o]) => o.project),
      ).toEqual(['untagged']);
    });

    it('skips the update from nx migrate instead of guessing between several projects', async () => {
      const workspace = createWorkspace(['app-one', 'app-two']);
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(workspace, { fromNxMigrate: true });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping the frontend update'),
      );
      expect(runFrontendMigration).not.toHaveBeenCalled();
    });

    it('throws outside nx migrate when several projects exist and there is no terminal', async () => {
      const workspace = createWorkspace(['app-one', 'app-two']);
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(updateFrontendGenerator(workspace, {})).rejects.toThrow(
        'Pass --project with one of: app-one, app-two',
      );
    });

    it('prompts for the project when a terminal is available', async () => {
      const workspace = createWorkspace(['app-one', 'app-two']);
      isInteractive.mockReturnValue(true);
      select
        .mockResolvedValueOnce('app-two')
        .mockResolvedValueOnce(CURRENT_FRONTEND_VERSION);
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(workspace, {});

      expect(
        runFrontendMigration.mock.calls.map(([, o]) => o.project),
      ).toEqual(['app-two']);
    });

    it('throws when the project prompt returns nothing', async () => {
      const workspace = createWorkspace(['app-one', 'app-two']);
      isInteractive.mockReturnValue(true);
      select.mockResolvedValue(undefined);
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(updateFrontendGenerator(workspace, {})).rejects.toThrow(
        'No project selected',
      );
    });
  });

  describe('project configuration', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('throws when the named project is not in the workspace', async () => {
      const workspace = createWorkspace();
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(
        updateFrontendGenerator(workspace, { project: 'missing' }),
      ).rejects.toThrow('Project configuration for missing not found');
    });

    it('throws when the project has no frontendVersion', async () => {
      const workspace = createTreeWithEmptyWorkspace();
      addProjectConfiguration(workspace, 'no-version', {
        root: 'no-version',
        projectType: 'application',
        sourceRoot: 'no-version/src',
        tags: ['nx-fhir-frontend'],
      } as ProjectConfiguration);
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(
        updateFrontendGenerator(workspace, { project: 'no-version' }),
      ).rejects.toThrow('does not have a frontendVersion configured');
    });
  });

  describe('target version', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('throws when no newer template version is reachable', async () => {
      const workspace = createTreeWithEmptyWorkspace();
      addFrontendProject(workspace, 'current', {
        frontendVersion: CURRENT_FRONTEND_VERSION,
      });
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(
        updateFrontendGenerator(workspace, { project: 'current' }),
      ).rejects.toThrow('No migration path available from frontend version');
    });

    it('prompts for the target version and runs the selected one', async () => {
      const workspace = createWorkspace();
      isInteractive.mockReturnValue(true);
      select.mockResolvedValue(CURRENT_FRONTEND_VERSION);
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(workspace, { project: 'app-one' });

      expect(select).toHaveBeenCalledTimes(1);
      expect(
        runFrontendMigration.mock.calls.map(([, o]) => o.toVersion),
      ).toEqual([CURRENT_FRONTEND_VERSION]);
    });

    it('runs no migration when Skip is selected', async () => {
      const workspace = createWorkspace();
      isInteractive.mockReturnValue(true);
      select.mockResolvedValue(SKIP);
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(workspace, { project: 'app-one' });

      expect(runFrontendMigration).not.toHaveBeenCalled();
    });

    it('throws when the requested target version has no migration path', async () => {
      const workspace = createWorkspace();
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(
        updateFrontendGenerator(workspace, {
          project: 'app-one',
          targetVersion: '9.9.9',
        }),
      ).rejects.toThrow('Cannot migrate from 0.2.0 to 9.9.9');
    });

    it('runs no migration when the project is already at the target version', async () => {
      const workspace = createWorkspace();
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(workspace, {
        project: 'app-one',
        targetVersion: '0.2.0',
      });

      expect(runFrontendMigration).not.toHaveBeenCalled();
    });
  });

  describe('migration results', () => {
    beforeEach(resetMocks);
    afterEach(() => vi.restoreAllMocks());

    it('throws when a migration step fails', async () => {
      const workspace = createWorkspace();
      runFrontendMigration.mockResolvedValueOnce({
        success: false,
        hasConflicts: false,
        projectResults: [],
        skippedProjects: [],
      });
      const { updateFrontendGenerator } = await import('./update-frontend');

      await expect(
        updateFrontendGenerator(workspace, {
          project: 'app-one',
          targetVersion: CURRENT_FRONTEND_VERSION,
        }),
      ).rejects.toThrow(`Migration 0.2.0 → ${CURRENT_FRONTEND_VERSION} failed`);
    });

    it('reports success when the last step has conflicts', async () => {
      const workspace = createWorkspace();
      runFrontendMigration.mockResolvedValueOnce({
        success: true,
        hasConflicts: true,
        projectResults: [],
        skippedProjects: [],
      });
      const { updateFrontendGenerator } = await import('./update-frontend');

      await updateFrontendGenerator(workspace, {
        project: 'app-one',
        targetVersion: CURRENT_FRONTEND_VERSION,
      });

      expect(confirm).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Successfully updated app-one'),
      );
    });
  });
});
