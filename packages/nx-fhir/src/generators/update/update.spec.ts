import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readJson,
  readProjectConfiguration,
  writeJson,
} from '@nx/devkit';

import { PLUGIN_VERSION } from '../../shared/constants/versions';

const callOrder: string[] = [];
const updateServerGenerator = vi.hoisted(() => vi.fn());
const updateFrontendGenerator = vi.hoisted(() => vi.fn());
const isInteractive = vi.hoisted(() => vi.fn(() => false));
const select = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());

vi.mock('../update-server/update-server', () => ({ updateServerGenerator }));
vi.mock('../update-frontend/update-frontend', () => ({
  updateFrontendGenerator,
}));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));
vi.mock('@inquirer/prompts', () => ({ select, confirm }));

import { updateGenerator } from './update';

const NO_SERVERS = 'No FHIR server projects found in the workspace';
const NO_FRONTENDS = 'No FHIR frontend projects found in the workspace';

function addServerProject(tree: Tree, name: string, pluginVersion?: string) {
  addProjectConfiguration(tree, name, {
    root: name,
    projectType: 'application',
    sourceRoot: `${name}/src`,
    tags: ['nx-fhir-server'],
    ...(pluginVersion ? { pluginVersion } : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe('update generator', () => {
  let tree: Tree;

  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    isInteractive.mockReturnValue(false);
    updateServerGenerator.mockImplementation(async () => {
      callOrder.push('server');
    });
    updateFrontendGenerator.mockImplementation(async () => {
      callOrder.push('frontend');
    });
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    tree = createTreeWithEmptyWorkspace();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('empty workspace', () => {
    beforeEach(() => {
      updateServerGenerator.mockRejectedValue(new Error(NO_SERVERS));
      updateFrontendGenerator.mockRejectedValue(new Error(NO_FRONTENDS));
    });

    it('completes without throwing when there is nothing to update', async () => {
      await expect(updateGenerator(tree, {})).resolves.toBeUndefined();
    });

    it('leaves nx.json untouched', async () => {
      const before = readJson(tree, 'nx.json');

      await updateGenerator(tree, {});

      expect(readJson(tree, 'nx.json')).toEqual(before);
    });

    it('asks nothing', async () => {
      await updateGenerator(tree, {});

      expect(select).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe('downstream call contract', () => {
    it('checks the server before the frontend', async () => {
      await updateGenerator(tree, {});

      expect(callOrder).toEqual(['server', 'frontend']);
      expect(updateServerGenerator).toHaveBeenCalledTimes(1);
      expect(updateFrontendGenerator).toHaveBeenCalledTimes(1);
    });

    it('returns the server outcome callback', async () => {
      const outcome = vi.fn();
      updateServerGenerator.mockResolvedValue(outcome);

      await expect(updateGenerator(tree, {})).resolves.toBe(outcome);
    });

    it('passes the tree and the force option to both generators', async () => {
      await updateGenerator(tree, { force: true });

      expect(updateServerGenerator).toHaveBeenCalledWith(tree, {
        force: true,
        fromNxMigrate: undefined,
      });
      expect(updateFrontendGenerator).toHaveBeenCalledWith(tree, {
        force: true,
        fromNxMigrate: undefined,
      });
    });

    it('passes an undefined force option when none is given', async () => {
      await updateGenerator(tree, {});

      expect(updateServerGenerator).toHaveBeenCalledWith(tree, {
        force: undefined,
        fromNxMigrate: undefined,
      });
      expect(updateFrontendGenerator).toHaveBeenCalledWith(tree, {
        force: undefined,
        fromNxMigrate: undefined,
      });
    });

    it('forwards the fromNxMigrate flag to both generators', async () => {
      await updateGenerator(tree, { fromNxMigrate: true });

      expect(updateServerGenerator).toHaveBeenCalledWith(tree, {
        force: undefined,
        fromNxMigrate: true,
      });
      expect(updateFrontendGenerator).toHaveBeenCalledWith(tree, {
        force: undefined,
        fromNxMigrate: true,
      });
    });
  });

  describe('nx.json installation versions', () => {
    it('leaves the installation block unchanged and warns', async () => {
      writeJson(tree, 'nx.json', {
        installation: {
          version: '22.1.3',
          plugins: { '@nx/maven': '22.1.3', 'nx-fhir': '0.0.1' },
        },
      });
      const before = tree.read('nx.json', 'utf-8');

      await updateGenerator(tree, {});

      expect(tree.read('nx.json', 'utf-8')).toBe(before);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('create-nx-fhir .'),
      );
    });

    it('does nothing without an installation block', async () => {
      const before = tree.read('nx.json', 'utf-8');

      await updateGenerator(tree, {});

      expect(tree.read('nx.json', 'utf-8')).toBe(before);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('project plugin versions', () => {
    it('updates a stale pluginVersion', async () => {
      addServerProject(tree, 'server', '0.0.1');

      await updateGenerator(tree, {});

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = readProjectConfiguration(tree, 'server') as any;
      expect(config.pluginVersion).toBe(PLUGIN_VERSION);
    });

    it('leaves a project without a pluginVersion alone', async () => {
      addServerProject(tree, 'server');

      await updateGenerator(tree, {});

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = readProjectConfiguration(tree, 'server') as any;
      expect(config.pluginVersion).toBeUndefined();
    });

    it('updates every managed project', async () => {
      addServerProject(tree, 'server-one', '0.0.1');
      addServerProject(tree, 'server-two', '0.0.2');

      await updateGenerator(tree, {});

      for (const name of ['server-one', 'server-two']) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const config = readProjectConfiguration(tree, name) as any;
        expect(config.pluginVersion).toBe(PLUGIN_VERSION);
      }
    });
  });

  describe('error posture', () => {
    it('continues to the frontend check when no server projects exist', async () => {
      updateServerGenerator.mockRejectedValue(new Error(NO_SERVERS));

      await updateGenerator(tree, {});

      expect(updateFrontendGenerator).toHaveBeenCalledTimes(1);
    });

    it('continues to the frontend check when the server is up to date', async () => {
      updateServerGenerator.mockRejectedValue(
        new Error('No migration path available from HAPI FHIR version 8.10.0-3'),
      );

      await updateGenerator(tree, {});

      expect(updateFrontendGenerator).toHaveBeenCalledTimes(1);
    });

    it('completes when the frontend is up to date', async () => {
      updateFrontendGenerator.mockRejectedValue(
        new Error('No migration path available from frontend version 0.3.0'),
      );

      await expect(updateGenerator(tree, {})).resolves.toBeUndefined();
    });

    it('completes when no frontend projects exist', async () => {
      updateFrontendGenerator.mockRejectedValue(new Error(NO_FRONTENDS));

      await expect(updateGenerator(tree, {})).resolves.toBeUndefined();
    });

    it('continues to the frontend check when the server has no recorded release', async () => {
      updateServerGenerator.mockRejectedValue(
        new Error('Project server does not have a hapiReleaseVersion configured.'),
      );

      await updateGenerator(tree, {});

      expect(updateFrontendGenerator).toHaveBeenCalledTimes(1);
    });

    it('completes when the frontend has no recorded template version', async () => {
      updateFrontendGenerator.mockRejectedValue(
        new Error('Project web does not have a frontendVersion configured.'),
      );

      await expect(updateGenerator(tree, {})).resolves.toBeUndefined();
    });

    it('rethrows an unexpected server error and skips the frontend check', async () => {
      updateServerGenerator.mockRejectedValue(new Error('download failed'));

      await expect(updateGenerator(tree, {})).rejects.toThrow('download failed');
      expect(updateFrontendGenerator).not.toHaveBeenCalled();
    });

    it('rethrows an unexpected frontend error', async () => {
      updateFrontendGenerator.mockRejectedValue(new Error('merge failed'));

      await expect(updateGenerator(tree, {})).rejects.toThrow('merge failed');
    });

    it('rethrows a thrown value that is not an Error', async () => {
      updateServerGenerator.mockRejectedValue('boom');

      await expect(updateGenerator(tree, {})).rejects.toBe('boom');
    });
  });

  describe('messages the swallow logic matches on', () => {
    it('are the messages the real generators throw', async () => {
      const server = await vi.importActual<
        typeof import('../update-server/update-server')
      >('../update-server/update-server');
      const frontend = await vi.importActual<
        typeof import('../update-frontend/update-frontend')
      >('../update-frontend/update-frontend');

      await expect(
        server.updateServerGenerator(tree, { fromNxMigrate: true }),
      ).rejects.toThrow(/No FHIR server projects found/);
      await expect(
        frontend.updateFrontendGenerator(tree, { fromNxMigrate: true }),
      ).rejects.toThrow(/No FHIR frontend projects found/);
    });
  });
});
