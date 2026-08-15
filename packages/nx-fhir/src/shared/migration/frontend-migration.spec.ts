import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  readJson,
  readProjectConfiguration,
  updateProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import { render as renderEjs } from 'ejs';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const execSync = vi.hoisted(() => vi.fn());
const extract = vi.hoisted(() => vi.fn());
const detectPackageManager = vi.hoisted(() => vi.fn(() => 'bun'));
const writeFileSync = vi.hoisted(() => vi.fn());
const rmSync = vi.hoisted(() => vi.fn());
const renameSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync,
}));

vi.mock('tar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tar')>()),
  extract,
}));

vi.mock('@nx/devkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nx/devkit')>();
  return {
    ...actual,
    detectPackageManager,
    logger: {
      ...actual.logger,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // The tree root has no directory on disk, so writes and removals below it
  // are recorded only. Every other path is served by the real filesystem.
  const isVirtual = (target: unknown): boolean =>
    String(target).startsWith('/virtual');
  writeFileSync.mockImplementation((target, ...args) => {
    if (!isVirtual(target)) {
      (actual.writeFileSync as (...a: unknown[]) => void)(target, ...args);
    }
  });
  rmSync.mockImplementation((target, ...args) => {
    if (!isVirtual(target)) {
      (actual.rmSync as (...a: unknown[]) => void)(target, ...args);
    }
  });
  renameSync.mockImplementation((source, target) => {
    if (!isVirtual(source)) {
      (actual.renameSync as (...a: unknown[]) => void)(source, target);
    }
  });
  const mocked = { ...actual, writeFileSync, rmSync, renameSync };
  return { ...mocked, default: mocked };
});

import {
  downloadOldFrontendTemplates,
  findFrontendProjectsToMigrate,
  FrontendMigrationResult,
  runFrontendMigration,
} from './frontend-migration';
import {
  FRONTEND_TEMPLATE_CONFIG,
  getFrontendDependencies,
} from '../../generators/frontend/frontend';
import {
  FhirVersion,
  FrontendProjectConfiguration,
  ServerProjectConfiguration,
} from '../models';
import { PLUGIN_VERSION } from '../constants/versions';
import {
  getCiInstallCommand,
  getDockerBaseImage,
  getLockfileName,
  getRunCommand,
} from '../utils/package-manager';

const templatesRoot = join(__dirname, '../../generators/frontend/files');
const projectName = 'frontend';
const fromVersion = '0.2.1';
const toVersion = PLUGIN_VERSION;

/** Contents of a template file shipped by the currently installed plugin */
function readTemplate(relativePath: string): string {
  return readFileSync(join(templatesRoot, relativePath), 'utf-8');
}

function withFirstLine(content: string, line: string): string {
  return `${line}\n${content}`;
}

let fetchMock: ReturnType<typeof vi.fn>;
let downloadDirsBefore: Set<string>;

function listDownloadDirs(): string[] {
  return readdirSync(tmpdir()).filter((entry) =>
    entry.startsWith('nx-fhir-frontend-')
  );
}

/**
 * Serves a set of old template files, keyed by their path below
 * `src/generators/frontend/files`, in place of the npm tarball.
 */
function stageOldTemplates(files: Record<string, string>): void {
  extract.mockImplementation(async ({ cwd }: { cwd: string }) => {
    for (const [relativePath, content] of Object.entries(files)) {
      const destination = join(
        cwd,
        'package/src/generators/frontend/files',
        relativePath
      );
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
  });
}

interface WorkspaceOptions {
  template?: 'browser' | 'clinical';
  navigationLayout?: 'sidebar' | 'topnav';
  workspaces?: string[];
  currentFiles?: Record<string, string>;
  projectRoot?: string;
}

function createWorkspace(options: WorkspaceOptions = {}): Tree {
  const tree = createTreeWithEmptyWorkspace();
  const projectRoot = options.projectRoot ?? projectName;

  if (options.workspaces) {
    writeJson(tree, 'package.json', {
      ...readJson(tree, 'package.json'),
      workspaces: options.workspaces,
    });
  }

  const projectConfiguration: FrontendProjectConfiguration = {
    root: projectRoot,
    projectType: 'application',
    sourceRoot: `${projectRoot}/src`,
    tags: ['nx-fhir-frontend'],
    frontendVersion: fromVersion,
    frontendTemplate: options.template ?? 'browser',
    navigationLayout: options.navigationLayout ?? 'sidebar',
    pluginVersion: fromVersion,
  };
  addProjectConfiguration(tree, projectName, projectConfiguration);

  writeJson(tree, `${projectRoot}/package.json`, {
    name: projectName,
    dependencies: {},
    devDependencies: {},
  });

  for (const [relativePath, content] of Object.entries(
    options.currentFiles ?? {}
  )) {
    tree.write(`${projectRoot}/${relativePath}`, content);
  }

  return tree;
}

function readProjectFile(tree: Tree, relativePath: string): string {
  return tree.read(`${projectName}/${relativePath}`, 'utf-8') ?? '';
}

/** Lockfiles the migration moved aside before the lockfile-free install. */
function removedLockfiles(): string[] {
  return renameSync.mock.calls
    .map(([source]) => String(source))
    .filter((source) =>
      /(bun\.lock|bun\.lockb|package-lock\.json)$/.test(source)
    );
}

describe('frontend-migration', () => {
  it('creates virtual trees under the root the fs mock treats as virtual', () => {
    // Guards the '/virtual' prefix in the fs mock above; a different tree
    // root would leak mocked writes onto the real filesystem.
    expect(createTreeWithEmptyWorkspace().root).toBe('/virtual');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    downloadDirsBefore = new Set(listDownloadDirs());
    detectPackageManager.mockReturnValue('bun');
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    vi.stubGlobal('fetch', fetchMock);
    stageOldTemplates({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const entry of listDownloadDirs()) {
      if (!downloadDirsBefore.has(entry)) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
    }
  });

  describe('findFrontendProjectsToMigrate', () => {
    it('returns the requested project without inspecting the workspace', () => {
      const tree = createTreeWithEmptyWorkspace();

      expect(
        findFrontendProjectsToMigrate(tree, fromVersion, 'anything')
      ).toEqual(['anything']);
    });

    it('returns only the projects at the source version', () => {
      const tree = createTreeWithEmptyWorkspace();
      addProjectConfiguration(tree, 'old-frontend', {
        root: 'old-frontend',
        frontendVersion: fromVersion,
      } as FrontendProjectConfiguration);
      addProjectConfiguration(tree, 'current-frontend', {
        root: 'current-frontend',
        frontendVersion: toVersion,
      } as FrontendProjectConfiguration);
      addProjectConfiguration(tree, 'server', { root: 'server' });

      expect(findFrontendProjectsToMigrate(tree, fromVersion)).toEqual([
        'old-frontend',
      ]);
    });
  });

  describe('downloadOldFrontendTemplates', () => {
    it('reports the HTTP status when the registry rejects the request', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404 });

      await expect(downloadOldFrontendTemplates('0.0.1')).rejects.toThrow(
        'Failed to download nx-fhir@0.0.1: HTTP 404'
      );
    });

    it('fails when the tarball holds no frontend template files', async () => {
      await expect(downloadOldFrontendTemplates(fromVersion)).rejects.toThrow(
        /Template files not found/
      );
    });

    it('returns the extracted template directory', async () => {
      stageOldTemplates({ 'common/marker.txt': 'marker' });

      const filesDir = await downloadOldFrontendTemplates(fromVersion);

      expect(existsSync(join(filesDir, 'common/marker.txt'))).toBe(true);
    });
  });

  describe('runFrontendMigration', () => {
    it('does nothing when no project is at the source version', async () => {
      const tree = createWorkspace();

      const result = await runFrontendMigration(tree, {
        fromVersion: '0.0.1',
        toVersion,
      });

      expect(result.projectResults).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(execSync).not.toHaveBeenCalled();
    });

    it('renders the old templates with the project name and the template defaults', async () => {
      stageOldTemplates({
        'browser/vite.config.ts': readTemplate('browser/vite.config.ts'),
        'common/src/app-info.ts.template':
          "export const projectName = '<%= name %>';\nexport const appTitle = '<%= appTitle %>';\n",
      });
      const tree = createWorkspace({
        currentFiles: {
          'src/app-info.ts': `export const projectName = '${projectName}';\nexport const appTitle = '${FRONTEND_TEMPLATE_CONFIG.browser.appTitle}';\n`,
        },
      });

      const result = await runFrontendMigration(tree, {
        fromVersion,
        toVersion,
      });

      expect(tree.exists(`${projectName}/src/app-info.ts`)).toBe(false);
      expect(result.projectResults[0].summary.removed).toBe(1);
    });

    it('skips a requested project that the workspace does not have', async () => {
      stageOldTemplates({
        'browser/vite.config.ts': readTemplate('browser/vite.config.ts'),
        'common/src/lib/utils.ts': readTemplate('common/src/lib/utils.ts'),
      });
      const tree = createWorkspace();

      const result = await runFrontendMigration(tree, {
        fromVersion,
        toVersion,
        project: 'missing',
      });

      expect(result.skippedProjects).toEqual(['missing']);
      expect(execSync).not.toHaveBeenCalled();
    });

    it('reports an old package without a known template layout', async () => {
      stageOldTemplates({ 'unexpected/file.txt': 'content' });
      const tree = createWorkspace();

      await expect(
        runFrontendMigration(tree, { fromVersion, toVersion })
      ).rejects.toThrow(/Could not find template directories/);
    });

    it('names the failing template when rendering the old templates fails', async () => {
      stageOldTemplates({
        'browser/vite.config.ts': readTemplate('browser/vite.config.ts'),
        'common/src/broken.ts.template':
          'export const value = <%= missingVariable %>;\n',
      });
      const tree = createWorkspace();

      await expect(
        runFrontendMigration(tree, { fromVersion, toVersion })
      ).rejects.toThrow('Failed to render template src/broken.ts.template');
    });

    it('reads the legacy webapp template layout', async () => {
      const templatePath = 'common/src/lib/utils.ts';
      const oldContent = withFirstLine(
        readTemplate(templatePath),
        '// old template line'
      );
      stageOldTemplates({ 'webapp/src/lib/utils.ts': oldContent });
      const tree = createWorkspace({
        currentFiles: { 'src/lib/utils.ts': oldContent },
      });

      await runFrontendMigration(tree, { fromVersion, toVersion });

      expect(readProjectFile(tree, 'src/lib/utils.ts')).toBe(
        readTemplate(templatePath)
      );
    });

    it('resolves the clinical navigation variant', async () => {
      stageOldTemplates({
        'clinical/vite.config.ts': readTemplate('clinical/vite.config.ts'),
        'common/src/lib/utils.ts': readTemplate('common/src/lib/utils.ts'),
      });
      const tree = createWorkspace({
        template: 'clinical',
        navigationLayout: 'topnav',
      });

      await runFrontendMigration(tree, { fromVersion, toVersion });

      expect(readProjectFile(tree, 'src/routes/__root.tsx')).toBe(
        readTemplate('clinical/_variants/__root-topnav.tsx')
      );
      expect(tree.exists(`${projectName}/_variants/__root-topnav.tsx`)).toBe(
        false
      );
      expect(tree.exists(`${projectName}/src/components/ui/sidebar.tsx`)).toBe(
        false
      );
    });

    describe('three-way merge', () => {
      const upstreamOnly = 'common/src/lib/utils.ts';
      const userOnly = 'common/src/hooks/use-theme.ts';
      const bothSides = 'common/src/hooks/use-fhir-api.ts';
      let tree: Tree;
      let result: FrontendMigrationResult;

      beforeEach(async () => {
        stageOldTemplates({
          'browser/vite.config.ts': readTemplate('browser/vite.config.ts'),
          [upstreamOnly]: withFirstLine(
            readTemplate(upstreamOnly),
            '// old template line'
          ),
          [userOnly]: readTemplate(userOnly),
          [bothSides]: withFirstLine(
            readTemplate(bothSides),
            '// old template line'
          ),
        });
        tree = createWorkspace({
          currentFiles: {
            'src/lib/utils.ts': withFirstLine(
              readTemplate(upstreamOnly),
              '// old template line'
            ),
            'src/hooks/use-theme.ts': withFirstLine(
              readTemplate(userOnly),
              '// user edit'
            ),
            'src/hooks/use-fhir-api.ts': withFirstLine(
              readTemplate(bothSides),
              '// user edit'
            ),
          },
        });

        result = await runFrontendMigration(tree, { fromVersion, toVersion });
      });

      it('takes the new template for a file the user did not change', () => {
        expect(readProjectFile(tree, 'src/lib/utils.ts')).toBe(
          readTemplate(upstreamOnly)
        );
      });

      it('keeps the user changes for a file the templates did not change', () => {
        expect(readProjectFile(tree, 'src/hooks/use-theme.ts')).toBe(
          withFirstLine(readTemplate(userOnly), '// user edit')
        );
      });

      it('marks conflicts when both sides changed the same lines', () => {
        const merged = readProjectFile(tree, 'src/hooks/use-fhir-api.ts');

        expect(merged).toContain('<<<<<<< CURRENT (Your changes)');
        expect(merged).toContain('// user edit');
        expect(merged).toContain('>>>>>>> NEW');
        expect(result.hasConflicts).toBe(true);
        expect(result.projectResults[0].summary.conflicts).toBe(1);
      });

      it('adds files the old templates did not have', () => {
        expect(tree.exists(`${projectName}/index.html`)).toBe(true);
        expect(result.projectResults[0].summary.added).toBeGreaterThan(0);
      });

      it('stamps the new frontend version on the project', () => {
        const configuration = readProjectConfiguration(
          tree,
          projectName
        ) as FrontendProjectConfiguration;

        expect(configuration.frontendVersion).toBe(toVersion);
        expect(configuration.pluginVersion).toBe(PLUGIN_VERSION);
      });

      it('syncs the project dependencies with the template', () => {
        const packageJson = readJson(tree, `${projectName}/package.json`);
        const expected = getFrontendDependencies('browser');

        expect(packageJson.dependencies).toMatchObject(expected.dependencies);
        expect(packageJson.devDependencies).toMatchObject(
          expected.devDependencies
        );
      });

      it('installs the dependencies from the project directory', () => {
        expect(execSync).toHaveBeenCalledTimes(1);
        expect(execSync).toHaveBeenCalledWith('bun install', {
          stdio: 'inherit',
          cwd: join(tree.root, projectName),
        });
      });
    });

    describe('server integration files', () => {
      const packageBase = 'org.custom.server';
      const dockerVars = {
        dot: '.',
        frontendRoot: projectName,
        serverRoot: 'server',
        dockerBaseImage: getDockerBaseImage('bun'),
        lockfileName: getLockfileName('bun'),
        ciInstallCommand: getCiInstallCommand('bun'),
        buildCommand: getRunCommand('bun', 'build'),
      };
      const baseTemplates = {
        'browser/vite.config.ts': readTemplate('browser/vite.config.ts'),
        'common/src/lib/utils.ts': readTemplate('common/src/lib/utils.ts'),
      };

      /** The docker templates rendered as the current plugin renders them */
      function renderedDocker(relativePath: string): string {
        return renderEjs(readTemplate(relativePath), dockerVars);
      }

      function createIntegratedWorkspace(
        currentFiles: Record<string, string> = {}
      ): Tree {
        const tree = createWorkspace();

        const serverConfiguration: ServerProjectConfiguration = {
          root: 'server',
          projectType: 'application',
          tags: ['fhir', 'server'],
          packageBase,
          fhirVersion: FhirVersion.R4,
          pluginVersion: fromVersion,
        };
        addProjectConfiguration(tree, 'server', serverConfiguration);

        const frontendConfiguration = readProjectConfiguration(
          tree,
          projectName
        );
        frontendConfiguration.targets = {
          'copy-to-server': {
            executor: 'nx:run-commands',
            options: {
              commands: [
                'rimraf --glob "../server/src/main/resources/static/*"',
                'cpy "dist/**" "../server/src/main/resources/static" --cwd=.',
              ],
            },
          },
        };
        updateProjectConfiguration(tree, projectName, frontendConfiguration);

        for (const [relativePath, content] of Object.entries(currentFiles)) {
          tree.write(relativePath, content);
        }
        return tree;
      }

      it('updates unchanged docker files to the new templates', async () => {
        const oldDocker = 'FROM old-base AS build-frontend\nCMD ["old"]\n';
        const oldDockerignore = '.git\nold-entry\n';
        stageOldTemplates({
          ...baseTemplates,
          'docker/Dockerfile.template': oldDocker,
          'docker/__dot__dockerignore.template': oldDockerignore,
        });
        const tree = createIntegratedWorkspace({
          Dockerfile: oldDocker,
          '.dockerignore': oldDockerignore,
        });

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(tree.read('Dockerfile', 'utf-8')).toBe(
          renderedDocker('docker/Dockerfile.template')
        );
        expect(tree.read('.dockerignore', 'utf-8')).toBe(
          renderedDocker('docker/__dot__dockerignore.template')
        );
      });

      it('keeps user edits when the docker templates did not change', async () => {
        stageOldTemplates({
          ...baseTemplates,
          'docker/Dockerfile.template': readTemplate(
            'docker/Dockerfile.template'
          ),
          'docker/__dot__dockerignore.template': readTemplate(
            'docker/__dot__dockerignore.template'
          ),
        });
        const editedDockerfile = withFirstLine(
          renderedDocker('docker/Dockerfile.template'),
          '# user edit'
        );
        const tree = createIntegratedWorkspace({
          Dockerfile: editedDockerfile,
          '.dockerignore': renderedDocker('docker/__dot__dockerignore.template'),
        });

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(tree.read('Dockerfile', 'utf-8')).toBe(editedDockerfile);
      });

      it('reports a conflict when both sides changed the same lines', async () => {
        stageOldTemplates({
          ...baseTemplates,
          'docker/Dockerfile.template': withFirstLine(
            readTemplate('docker/Dockerfile.template'),
            '# old template line'
          ),
          'docker/__dot__dockerignore.template': readTemplate(
            'docker/__dot__dockerignore.template'
          ),
        });
        const tree = createIntegratedWorkspace({
          Dockerfile: withFirstLine(
            renderedDocker('docker/Dockerfile.template'),
            '# user edit'
          ),
          '.dockerignore': renderedDocker('docker/__dot__dockerignore.template'),
        });

        const result = await runFrontendMigration(tree, {
          fromVersion,
          toVersion,
        });

        expect(result.hasConflicts).toBe(true);
        const conflictPaths = result.projectResults[0].summary.results
          .filter((entry) => entry.status === 'conflict')
          .map((entry) => entry.path);
        expect(conflictPaths).toContain('Dockerfile');
        expect(tree.read('Dockerfile', 'utf-8')).toContain(
          '<<<<<<< CURRENT (Your changes)'
        );
      });

      it('migrates the integration Java classes into the server source tree', async () => {
        const javaTemplate = 'server/config/SpaController.java.template';
        const javaPath = `server/src/main/java/${packageBase.replace(
          /\./g,
          '/'
        )}/config/SpaController.java`;
        stageOldTemplates({
          ...baseTemplates,
          [javaTemplate]: withFirstLine(
            readTemplate(javaTemplate),
            '// old template line'
          ),
        });
        const tree = createIntegratedWorkspace({
          [javaPath]: renderEjs(
            withFirstLine(readTemplate(javaTemplate), '// old template line'),
            { packageBase }
          ),
        });

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(tree.read(javaPath, 'utf-8')).toBe(
          renderEjs(readTemplate(javaTemplate), { packageBase })
        );
      });

      it('leaves integration files alone for a project without server integration', async () => {
        stageOldTemplates({
          ...baseTemplates,
          'docker/Dockerfile.template': readTemplate(
            'docker/Dockerfile.template'
          ),
        });
        const tree = createWorkspace();
        tree.write('Dockerfile', '# my custom dockerfile\n');

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(tree.read('Dockerfile', 'utf-8')).toBe(
          '# my custom dockerfile\n'
        );
        expect(tree.exists('.dockerignore')).toBe(false);
      });

      it('skips docker files when the old plugin version has no docker templates', async () => {
        stageOldTemplates(baseTemplates);
        const tree = createIntegratedWorkspace({
          Dockerfile: '# my custom dockerfile\n',
        });

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(tree.read('Dockerfile', 'utf-8')).toBe(
          '# my custom dockerfile\n'
        );
      });
    });

    it('performs no filesystem or install side effects on a dry run', async () => {
      stageOldTemplates({
        'browser/vite.config.ts': readTemplate('browser/vite.config.ts'),
        'common/src/lib/utils.ts': readTemplate('common/src/lib/utils.ts'),
      });
      const tree = createWorkspace();
      const originalArgv = process.argv;
      process.argv = [...originalArgv, '--dry-run'];

      let result;
      try {
        result = await runFrontendMigration(tree, { fromVersion, toVersion });
      } finally {
        process.argv = originalArgv;
      }

      // The tree still records the migration for Nx to preview.
      expect(result.projectResults).toHaveLength(1);
      expect(
        readJson(tree, `${projectName}/package.json`).dependencies,
      ).toMatchObject(getFrontendDependencies('browser').dependencies);

      expect(execSync).not.toHaveBeenCalled();
      expect(renameSync).not.toHaveBeenCalled();
      expect(
        writeFileSync.mock.calls.filter(([target]) =>
          String(target).includes(`${projectName}/package.json`),
        ),
      ).toEqual([]);
      expect(
        rmSync.mock.calls.filter(([target]) =>
          String(target).includes('.nx-fhir-backup'),
        ),
      ).toEqual([]);
    });

    describe('install and lockfile cleanup', () => {
      beforeEach(() => {
        stageOldTemplates({
          'browser/vite.config.ts': readTemplate('browser/vite.config.ts'),
          'common/src/lib/utils.ts': readTemplate('common/src/lib/utils.ts'),
        });
      });

      it('removes the root and project lockfiles for a workspace member', async () => {
        const tree = createWorkspace({ workspaces: [projectName] });

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(removedLockfiles()).toContain(join(tree.root, 'bun.lock'));
        expect(removedLockfiles()).toContain(
          join(tree.root, 'package-lock.json')
        );
        expect(removedLockfiles()).toContain(
          join(tree.root, projectName, 'bun.lock')
        );
      });

      it('restores the lockfile and manifest bytes on disk when the install fails', async () => {
        const { FsTree } = await vi.importActual<
          typeof import('nx/src/generators/tree')
        >('nx/src/generators/tree');
        const { mkdtempSync } = await vi.importActual<typeof import('fs')>(
          'fs'
        );

        const workspaceDir = mkdtempSync(join(tmpdir(), 'nx-fhir-rollback-'));
        try {
          writeFileSync(join(workspaceDir, 'nx.json'), '{}');
          writeFileSync(
            join(workspaceDir, 'package.json'),
            JSON.stringify({ name: 'ws', workspaces: [projectName] })
          );
          const rootLock = 'lockfile resolved from the previous manifest\n';
          writeFileSync(join(workspaceDir, 'bun.lock'), rootLock);
          mkdirSync(join(workspaceDir, projectName, 'src'), {
            recursive: true,
          });
          const projectManifest = JSON.stringify(
            { name: projectName, dependencies: {} },
            null,
            2
          );
          writeFileSync(
            join(workspaceDir, projectName, 'package.json'),
            projectManifest
          );
          const projectLock = 'project lockfile\n';
          writeFileSync(
            join(workspaceDir, projectName, 'bun.lock'),
            projectLock
          );
          const nodeModulesDir = join(workspaceDir, projectName, 'node_modules');
          mkdirSync(join(nodeModulesDir, 'left-pad'), { recursive: true });
          const installedMarker = 'installed module\n';
          writeFileSync(
            join(nodeModulesDir, 'left-pad', 'index.js'),
            installedMarker
          );
          writeFileSync(
            join(workspaceDir, projectName, 'project.json'),
            JSON.stringify({
              name: projectName,
              root: projectName,
              projectType: 'application',
              tags: ['nx-fhir-frontend'],
              frontendVersion: fromVersion,
              frontendTemplate: 'browser',
              navigationLayout: 'sidebar',
              pluginVersion: fromVersion,
            })
          );

          const tree = new FsTree(workspaceDir, false);
          execSync.mockImplementationOnce(() => {
            throw new Error('install failed');
          });

          await expect(
            runFrontendMigration(tree, { fromVersion, toVersion })
          ).rejects.toThrow('install failed');

          expect(readFileSync(join(workspaceDir, 'bun.lock'), 'utf-8')).toBe(
            rootLock
          );
          expect(
            readFileSync(join(workspaceDir, projectName, 'bun.lock'), 'utf-8')
          ).toBe(projectLock);
          expect(
            readFileSync(
              join(workspaceDir, projectName, 'package.json'),
              'utf-8'
            )
          ).toBe(projectManifest);
          expect(existsSync(join(workspaceDir, 'bun.lock.nx-fhir-backup'))).toBe(
            false
          );
          expect(
            readFileSync(join(nodeModulesDir, 'left-pad', 'index.js'), 'utf-8')
          ).toBe(installedMarker);
          expect(existsSync(`${nodeModulesDir}.nx-fhir-backup`)).toBe(false);
          expect(
            existsSync(join(workspaceDir, projectName, 'bun.lock.nx-fhir-backup'))
          ).toBe(false);
          expect(
            existsSync(
              join(workspaceDir, projectName, 'package.json.nx-fhir-backup')
            )
          ).toBe(false);
        } finally {
          rmSync(workspaceDir, { recursive: true, force: true });
        }
      });

      it('aborts without touching anything when a file and its backup both exist', async () => {
        const { FsTree } = await vi.importActual<
          typeof import('nx/src/generators/tree')
        >('nx/src/generators/tree');
        const { mkdtempSync } = await vi.importActual<typeof import('fs')>(
          'fs'
        );

        const workspaceDir = mkdtempSync(join(tmpdir(), 'nx-fhir-conflict-'));
        try {
          writeFileSync(join(workspaceDir, 'nx.json'), '{}');
          writeFileSync(
            join(workspaceDir, 'package.json'),
            JSON.stringify({ name: 'ws', workspaces: [projectName] })
          );
          mkdirSync(join(workspaceDir, projectName, 'src'), {
            recursive: true,
          });
          const projectManifest = JSON.stringify(
            { name: projectName, dependencies: {} },
            null,
            2
          );
          writeFileSync(
            join(workspaceDir, projectName, 'package.json'),
            projectManifest
          );
          writeFileSync(
            join(workspaceDir, projectName, 'project.json'),
            JSON.stringify({
              name: projectName,
              root: projectName,
              projectType: 'application',
              tags: ['nx-fhir-frontend'],
              frontendVersion: fromVersion,
              frontendTemplate: 'browser',
              navigationLayout: 'sidebar',
              pluginVersion: fromVersion,
            })
          );
          const currentLock = 'current lockfile\n';
          const backupLock = 'backup lockfile\n';
          writeFileSync(
            join(workspaceDir, projectName, 'bun.lock'),
            currentLock
          );
          writeFileSync(
            join(workspaceDir, projectName, 'bun.lock.nx-fhir-backup'),
            backupLock
          );

          const tree = new FsTree(workspaceDir, false);

          await expect(
            runFrontendMigration(tree, { fromVersion, toVersion })
          ).rejects.toThrow('interrupted migration');

          expect(execSync).not.toHaveBeenCalledWith(
            expect.stringContaining('install'),
            expect.anything()
          );
          expect(
            readFileSync(
              join(workspaceDir, projectName, 'package.json'),
              'utf-8'
            )
          ).toBe(projectManifest);
          expect(
            readFileSync(join(workspaceDir, projectName, 'bun.lock'), 'utf-8')
          ).toBe(currentLock);
          expect(
            readFileSync(
              join(workspaceDir, projectName, 'bun.lock.nx-fhir-backup'),
              'utf-8'
            )
          ).toBe(backupLock);
        } finally {
          rmSync(workspaceDir, { recursive: true, force: true });
        }
      });

      it('recovers backups left by an interrupted run instead of deleting them', async () => {
        const { FsTree } = await vi.importActual<
          typeof import('nx/src/generators/tree')
        >('nx/src/generators/tree');
        const { mkdtempSync } = await vi.importActual<typeof import('fs')>(
          'fs'
        );

        const workspaceDir = mkdtempSync(join(tmpdir(), 'nx-fhir-interrupted-'));
        try {
          writeFileSync(join(workspaceDir, 'nx.json'), '{}');
          writeFileSync(
            join(workspaceDir, 'package.json'),
            JSON.stringify({ name: 'ws', workspaces: [projectName] })
          );
          mkdirSync(join(workspaceDir, projectName, 'src'), {
            recursive: true,
          });
          // The previous run crashed after writing the migrated manifest
          // and moving the dependencies aside: the old manifest survives
          // only in its backup.
          const oldManifest = JSON.stringify(
            { name: projectName, dependencies: {} },
            null,
            2
          );
          writeFileSync(
            join(workspaceDir, projectName, 'package.json'),
            JSON.stringify(
              { name: projectName, dependencies: { 'left-pad': '2.0.0' } },
              null,
              2
            )
          );
          writeFileSync(
            join(workspaceDir, projectName, 'package.json.nx-fhir-backup'),
            oldManifest
          );
          writeFileSync(
            join(workspaceDir, projectName, 'project.json'),
            JSON.stringify({
              name: projectName,
              root: projectName,
              projectType: 'application',
              tags: ['nx-fhir-frontend'],
              frontendVersion: fromVersion,
              frontendTemplate: 'browser',
              navigationLayout: 'sidebar',
              pluginVersion: fromVersion,
            })
          );
          const oldLock = 'old lockfile\n';
          writeFileSync(
            join(workspaceDir, projectName, 'bun.lock.nx-fhir-backup'),
            oldLock
          );
          const nodeModulesDir = join(
            workspaceDir,
            projectName,
            'node_modules'
          );
          mkdirSync(join(`${nodeModulesDir}.nx-fhir-backup`, 'left-pad'), {
            recursive: true,
          });
          const oldModule = 'old module\n';
          writeFileSync(
            join(`${nodeModulesDir}.nx-fhir-backup`, 'left-pad', 'index.js'),
            oldModule
          );

          const tree = new FsTree(workspaceDir, false);
          execSync.mockImplementationOnce(() => {
            throw new Error('install failed');
          });

          await expect(
            runFrontendMigration(tree, { fromVersion, toVersion })
          ).rejects.toThrow('install failed');

          expect(
            readFileSync(join(workspaceDir, projectName, 'bun.lock'), 'utf-8')
          ).toBe(oldLock);
          expect(
            readFileSync(join(nodeModulesDir, 'left-pad', 'index.js'), 'utf-8')
          ).toBe(oldModule);
          expect(
            readFileSync(
              join(workspaceDir, projectName, 'package.json'),
              'utf-8'
            )
          ).toBe(oldManifest);
          expect(
            existsSync(join(workspaceDir, projectName, 'bun.lock.nx-fhir-backup'))
          ).toBe(false);
          expect(existsSync(`${nodeModulesDir}.nx-fhir-backup`)).toBe(false);
          expect(
            existsSync(
              join(workspaceDir, projectName, 'package.json.nx-fhir-backup')
            )
          ).toBe(false);
        } finally {
          rmSync(workspaceDir, { recursive: true, force: true });
        }
      });

      it('removes the root lockfile for a project matched by a workspaces glob', async () => {
        const tree = createWorkspace({
          projectRoot: `apps/${projectName}`,
          workspaces: ['apps/*'],
        });

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(removedLockfiles()).toContain(join(tree.root, 'bun.lock'));
        expect(removedLockfiles()).toContain(
          join(tree.root, 'apps', projectName, 'bun.lock')
        );
      });

      it('removes the root lockfile for a project matched by a globstar spanning zero segments', async () => {
        const tree = createWorkspace({
          projectRoot: `apps/${projectName}`,
          workspaces: [`apps/**/${projectName}`],
        });

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(removedLockfiles()).toContain(join(tree.root, 'bun.lock'));
      });

      it('keeps the root lockfile for a project outside the workspaces', async () => {
        const tree = createWorkspace({
          projectRoot: `apps/${projectName}`,
          workspaces: ['packages/*'],
        });

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(removedLockfiles()).not.toContain(join(tree.root, 'bun.lock'));
        expect(removedLockfiles()).not.toContain(
          join(tree.root, 'package-lock.json')
        );
        expect(removedLockfiles()).toContain(
          join(tree.root, 'apps', projectName, 'bun.lock')
        );
      });

      it('moves the project node_modules aside and drops the backup after a successful install', async () => {
        const tree = createWorkspace();

        await runFrontendMigration(tree, { fromVersion, toVersion });

        const nodeModules = join(tree.root, projectName, 'node_modules');
        expect(renameSync).toHaveBeenCalledWith(
          nodeModules,
          `${nodeModules}.nx-fhir-backup`
        );
        expect(rmSync).toHaveBeenCalledWith(`${nodeModules}.nx-fhir-backup`, {
          recursive: true,
          force: true,
        });
        expect(rmSync).toHaveBeenCalledWith(
          join(tree.root, projectName, 'package.json.nx-fhir-backup'),
          { force: true }
        );
      });

      it('runs the install command of the detected package manager', async () => {
        detectPackageManager.mockReturnValue('npm');
        const tree = createWorkspace();

        await runFrontendMigration(tree, { fromVersion, toVersion });

        expect(execSync).toHaveBeenCalledWith('npm install', {
          stdio: 'inherit',
          cwd: join(tree.root, projectName),
        });
      });
    });
  });
});
