import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutorContext, PackageManager } from '@nx/devkit';
import * as child_process from 'child_process';
import * as fs from 'fs';
import { join } from 'path';

const detectPackageManager = vi.hoisted(() =>
  vi.fn((): PackageManager => 'bun'),
);
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  fatal: vi.fn(),
  verbose: vi.fn(),
}));

vi.mock('@nx/devkit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  detectPackageManager,
  logger,
}));

vi.mock('fs');
vi.mock('child_process');

import executor from './executor';

const projectPath = join('/workspace', 'apps/test-project');

function existsOnly(fileName: string) {
  return (candidate: fs.PathLike) => candidate.toString().endsWith(fileName);
}

describe('Build Executor', () => {
  let context: ExecutorContext;

  beforeEach(() => {
    vi.resetAllMocks();
    detectPackageManager.mockReturnValue('bun');

    context = {
      root: '/workspace',
      projectName: 'test-project',
      projectsConfigurations: {
        version: 2,
        projects: {
          'test-project': {
            root: 'apps/test-project',
          },
        },
      },
      cwd: '/workspace',
      isVerbose: false,
      nxJsonConfiguration: {},
      projectGraph: {
        nodes: {},
        dependencies: {},
      },
    };
  });

  describe('project resolution', () => {
    it('should fail when the project configuration is missing', async () => {
      const result = await executor(
        {},
        { ...context, projectName: 'unknown-project' },
      );

      expect(result).toEqual({ success: false });
      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('unknown-project'),
      );
    });

    it('should fail when the executor runs without a project name', async () => {
      const result = await executor({}, { ...context, projectName: undefined });

      expect(result).toEqual({ success: false });
      expect(child_process.execSync).not.toHaveBeenCalled();
    });

    it('should fail when neither pom.xml nor package.json is present', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await executor({}, context);

      expect(result).toEqual({ success: false });
      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Unknown project type for test-project'),
      );
    });
  });

  describe('server projects', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('pom.xml'));
    });

    it('should run Maven package in the project directory', async () => {
      const result = await executor({}, context);

      expect(child_process.execSync).toHaveBeenCalledWith('mvn package', {
        cwd: projectPath,
        stdio: 'inherit',
      });
      expect(result).toEqual({ success: true });
    });

    it('should prepend the clean goal', async () => {
      await executor({ clean: true }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn clean package',
        expect.any(Object),
      );
    });

    it('should pass skipTests and production flags to Maven', async () => {
      await executor(
        { clean: true, skipTests: true, production: true },
        context,
      );

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn clean package -DskipTests -Pprod',
        expect.any(Object),
      );
    });

    it('should take precedence when package.json is also present', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      await executor({}, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'mvn package',
        expect.any(Object),
      );
    });

    it('should fail when Maven exits with a non-zero code', async () => {
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error('Command failed: mvn package');
      });

      const result = await executor({}, context);

      expect(result).toEqual({ success: false });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Maven build failed'),
      );
    });
  });

  describe('frontend projects', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockImplementation(existsOnly('package.json'));
    });

    it('should run the bun build script in the project directory', async () => {
      const result = await executor({}, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'bun run build',
        expect.objectContaining({
          cwd: projectPath,
          stdio: 'inherit',
        }),
      );
      expect(result).toEqual({ success: true });
    });

    it('should run the npm build script when npm is detected', async () => {
      detectPackageManager.mockReturnValue('npm');

      await executor({}, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'npm run build',
        expect.any(Object),
      );
    });

    it('should set NODE_ENV to development by default', async () => {
      await executor({}, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'bun run build',
        expect.objectContaining({
          env: expect.objectContaining({ NODE_ENV: 'development' }),
        }),
      );
    });

    it('should set NODE_ENV to production for a production build', async () => {
      await executor({ production: true }, context);

      expect(child_process.execSync).toHaveBeenCalledWith(
        'bun run build',
        expect.objectContaining({
          env: expect.objectContaining({ NODE_ENV: 'production' }),
        }),
      );
    });

    it('should fail when the build command exits with a non-zero code', async () => {
      vi.mocked(child_process.execSync).mockImplementation(() => {
        throw new Error('Command failed: bun run build');
      });

      const result = await executor({}, context);

      expect(result).toEqual({ success: false });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Build failed'),
      );
    });

    it('should fail for an unsupported package manager', async () => {
      detectPackageManager.mockReturnValue('pnpm');

      const result = await executor({}, context);

      expect(result).toEqual({ success: false });
      expect(child_process.execSync).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported package manager: pnpm'),
      );
    });
  });
});
