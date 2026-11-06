import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  joinPathFragments,
  logger,
  readJson,
  readProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import { readFileSync } from 'fs';
import { join } from 'path';

import { PLUGIN_VERSION, starterImageZipUrl } from '../../shared/constants/versions';
import { ServerProjectConfiguration } from '../../shared/models';
import {
  DockerFragments,
  insertFrontendLines,
  legacyDockerWarning,
} from '../../shared/utils/docker-splice';

const callOrder: string[] = [];
const runServerUpdate = vi.hoisted(() => vi.fn());
const updateFrontendGenerator = vi.hoisted(() => vi.fn());
const isInteractive = vi.hoisted(() => vi.fn(() => false));
const select = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());

vi.mock('../update-server/update-server', () => ({ runServerUpdate }));
vi.mock('../update-frontend/update-frontend', () => ({
  updateFrontendGenerator,
}));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));
vi.mock('@inquirer/prompts', () => ({ select, confirm }));

import { runUpdate, updateGenerator } from './update';

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
    runServerUpdate.mockImplementation(async () => {
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
      runServerUpdate.mockRejectedValue(new Error(NO_SERVERS));
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
      expect(runServerUpdate).toHaveBeenCalledTimes(1);
      expect(updateFrontendGenerator).toHaveBeenCalledTimes(1);
    });

    it('returns a callback that logs the server outcome at each line level', async () => {
      runServerUpdate.mockResolvedValue([
        { level: 'warn', text: 'paused with conflicts' },
        { level: 'info', text: 'updated' },
      ]);

      const callback = await updateGenerator(tree, {});
      vi.mocked(logger.info).mockClear();
      vi.mocked(logger.warn).mockClear();
      await callback?.();

      expect(logger.warn).toHaveBeenCalledWith('paused with conflicts');
      expect(logger.info).toHaveBeenCalledWith('updated');
    });

    it('returns no callback when the server update has no outcome', async () => {
      await expect(updateGenerator(tree, {})).resolves.toBeUndefined();
    });

    it('passes the tree and the force option to both generators', async () => {
      await updateGenerator(tree, { force: true });

      expect(runServerUpdate).toHaveBeenCalledWith(tree, {
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

      expect(runServerUpdate).toHaveBeenCalledWith(tree, {
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

      expect(runServerUpdate).toHaveBeenCalledWith(tree, {
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

  describe('legacy combined Dockerfile', () => {
    const release = '8.12.0-2';
    const combinedDockerfile = 'FROM node AS build-frontend\nFROM maven AS build-server\n';
    const fragments: DockerFragments = {
      frontendStage: 'FROM oven/bun:1-slim AS build-frontend\nWORKDIR /app\nRUN bun run build\n',
      copyFrontend:
        'COPY --from=build-frontend /app/frontend/dist/ /tmp/hapi-fhir-jpaserver-starter/src/main/resources/static/\n',
      dockerignoreLines: 'node_modules\nfrontend/node_modules\nfrontend/dist\n',
    };
    const [headline] = legacyDockerWarning(release, fragments);

    function addIntegratedWorkspace(serverRoot: string, frontendRoot: string, dockerfile: string) {
      addProjectConfiguration(tree, 'server', {
        root: serverRoot,
        projectType: 'application',
        hapiReleaseVersion: release,
      } as ServerProjectConfiguration);
      addProjectConfiguration(tree, 'frontend', {
        root: frontendRoot,
        projectType: 'application',
        targets: {
          'copy-to-server': {
            executor: 'nx:run-commands',
            options: {
              commands: [`cpy "dist/**" "../${serverRoot}/src/main/resources/static" --cwd=.`],
            },
          },
        },
      });
      tree.write(joinPathFragments(serverRoot, 'Dockerfile'), dockerfile);
    }

    it('reports a legacy combined Dockerfile once, after the updates', async () => {
      addIntegratedWorkspace('.', 'frontend', combinedDockerfile);
      runServerUpdate.mockResolvedValue([{ level: 'info', text: 'server updated' }]);

      const lines = (await runUpdate(tree, {})) ?? [];
      const texts = lines.map(({ text }) => text);

      expect(texts.slice(0, 2)).toEqual(['server updated', headline]);
      expect(lines.slice(1).every(({ level }) => level === 'warn')).toBe(true);
      expect(texts.join('\n')).toContain(starterImageZipUrl(release));
      expect(texts.filter((text) => text === headline)).toHaveLength(1);
    });

    it('reports nothing for a starter Dockerfile with the frontend lines', async () => {
      const fixtureDir = join(__dirname, '../../shared/utils/__fixtures__/starter-docker');
      const releases = JSON.parse(readFileSync(join(fixtureDir, 'releases.json'), 'utf-8'));
      const starter = readFileSync(join(fixtureDir, releases[release].dockerfile), 'utf-8');
      addIntegratedWorkspace('.', 'frontend', insertFrontendLines(starter, fragments) as string);

      await expect(runUpdate(tree, {})).resolves.toBeUndefined();
    });

    it('reports nothing for a nested server', async () => {
      addIntegratedWorkspace('server', 'server/frontend', combinedDockerfile);

      await expect(runUpdate(tree, {})).resolves.toBeUndefined();
    });
  });

  describe('error posture', () => {
    it('continues to the frontend check when no server projects exist', async () => {
      runServerUpdate.mockRejectedValue(new Error(NO_SERVERS));

      await updateGenerator(tree, {});

      expect(updateFrontendGenerator).toHaveBeenCalledTimes(1);
    });

    it('continues to the frontend check when the server is up to date', async () => {
      runServerUpdate.mockRejectedValue(
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
      runServerUpdate.mockRejectedValue(
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
      runServerUpdate.mockRejectedValue(new Error('download failed'));

      await expect(updateGenerator(tree, {})).rejects.toThrow('download failed');
      expect(updateFrontendGenerator).not.toHaveBeenCalled();
    });

    it('rethrows an unexpected frontend error', async () => {
      updateFrontendGenerator.mockRejectedValue(new Error('merge failed'));

      await expect(updateGenerator(tree, {})).rejects.toThrow('merge failed');
    });

    it('rethrows a thrown value that is not an Error', async () => {
      runServerUpdate.mockRejectedValue('boom');

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
        server.runServerUpdate(tree, { fromNxMigrate: true }),
      ).rejects.toThrow(/No FHIR server projects found/);
      await expect(
        frontend.updateFrontendGenerator(tree, { fromNxMigrate: true }),
      ).rejects.toThrow(/No FHIR frontend projects found/);
    });
  });
});
