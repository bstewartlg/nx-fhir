import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PackageManager } from '@nx/devkit';

const detectPackageManager = vi.hoisted(() => vi.fn());

vi.mock('@nx/devkit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nx/devkit')>()),
  detectPackageManager,
}));

import {
  getPackageManager,
  getInstallCommand,
  getListCommand,
  getRunCommand,
  getExecuteCommand,
  getPackCommand,
  getCiInstallCommand,
  getDockerBaseImage,
  getLockfileName,
} from './package-manager';

const unsupported = 'pnpm' as PackageManager;

function withPlatform(platform: string, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    run();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  }
}

describe('package-manager utils', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.npm_config_user_agent;
    delete process.env.PACKAGE_MANAGER;
    detectPackageManager.mockReturnValue('npm');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getPackageManager', () => {
    it('should prefer the PACKAGE_MANAGER environment variable over detection', () => {
      process.env.PACKAGE_MANAGER = 'bun';

      expect(getPackageManager()).toBe('bun');
      expect(detectPackageManager).not.toHaveBeenCalled();
    });

    it('should accept the environment variable in any case', () => {
      process.env.PACKAGE_MANAGER = 'NPM';

      expect(getPackageManager()).toBe('npm');
    });

    it('should fall back to detection when the environment variable is not supported', () => {
      process.env.PACKAGE_MANAGER = 'yarn';
      detectPackageManager.mockReturnValue('npm');

      expect(getPackageManager()).toBe('npm');
      expect(detectPackageManager).toHaveBeenCalled();
    });

    it('should fall back to detection when the environment variable is empty', () => {
      process.env.PACKAGE_MANAGER = '';
      detectPackageManager.mockReturnValue('bun');

      expect(getPackageManager()).toBe('bun');
    });

    it('should fall back to bun when detection returns nothing', () => {
      detectPackageManager.mockReturnValue(undefined);

      expect(getPackageManager()).toBe('bun');
    });
  });

  describe('getInstallCommand', () => {
    it('should return correct bun install command', () => {
      expect(getInstallCommand('bun', 'some-package', true)).toBe('bun install -D some-package');
      expect(getInstallCommand('bun', 'some-package', false)).toBe('bun install  some-package');
    });

    it('should return correct npm install command', () => {
      expect(getInstallCommand('npm', 'some-package', true)).toBe('npm install -D some-package');
      expect(getInstallCommand('npm', 'some-package', false)).toBe('npm install  some-package');
    });

    it('should return the bare install command when no package is named', () => {
      expect(getInstallCommand('bun')).toBe('bun install');
      expect(getInstallCommand('npm')).toBe('npm install');
    });

    it('should ignore the dev flag when no package is named', () => {
      expect(getInstallCommand('npm', undefined, true)).toBe('npm install');
    });

    it('should throw for an unsupported package manager', () => {
      expect(() => getInstallCommand(unsupported)).toThrow('Unsupported package manager: pnpm');
    });
  });

  describe('getListCommand', () => {
    it('should return correct bun list command', () => {
      expect(getListCommand('bun', 'some-package')).toMatch(/^bun pm ls \| (grep|findstr) some-package$/);
    });

    it('should pipe to grep on posix platforms', () => {
      withPlatform('linux', () => {
        expect(getListCommand('bun', 'some-package')).toBe('bun pm ls | grep some-package');
      });
    });

    it('should pipe to findstr on windows', () => {
      withPlatform('win32', () => {
        expect(getListCommand('bun', 'some-package')).toBe('bun pm ls | findstr some-package');
      });
    });

    it('should return correct npm list command', () => {
      expect(getListCommand('npm', 'some-package')).toBe('npm ls some-package');
    });

    it('should throw for an unsupported package manager', () => {
      expect(() => getListCommand(unsupported, 'some-package')).toThrow(
        'Unsupported package manager: pnpm',
      );
    });
  });

  describe('getRunCommand', () => {
    it('should return correct bun run command', () => {
      expect(getRunCommand('bun', 'test')).toBe('bun run test');
    });

    it('should return correct npm run command', () => {
      expect(getRunCommand('npm', 'test')).toBe('npm run test');
    });

    it('should throw for an unsupported package manager', () => {
      expect(() => getRunCommand(unsupported, 'test')).toThrow('Unsupported package manager: pnpm');
    });
  });

  describe('getExecuteCommand', () => {
    it('should return correct bunx command', () => {
      expect(getExecuteCommand('bun', 'some-cli')).toBe('bunx some-cli');
    });

    it('should return correct npx command', () => {
      expect(getExecuteCommand('npm', 'some-cli')).toBe('npx some-cli');
    });

    it('should return the runner alone when no command is given', () => {
      expect(getExecuteCommand('bun')).toBe('bunx');
      expect(getExecuteCommand('npm')).toBe('npx');
    });

    it('should throw for an unsupported package manager', () => {
      expect(() => getExecuteCommand(unsupported, 'some-cli')).toThrow(
        'Unsupported package manager: pnpm',
      );
    });
  });

  describe('getPackCommand', () => {
    it('should return the pack command for each package manager', () => {
      expect(getPackCommand('bun')).toBe('bun pm pack');
      expect(getPackCommand('npm')).toBe('npm pack');
    });

    it('should throw for an unsupported package manager', () => {
      expect(() => getPackCommand(unsupported)).toThrow('Unsupported package manager: pnpm');
    });
  });

  describe('getCiInstallCommand', () => {
    it('should return a frozen lockfile install for each package manager', () => {
      expect(getCiInstallCommand('bun')).toBe('bun install --frozen-lockfile');
      expect(getCiInstallCommand('npm')).toBe('npm ci');
    });

    it('should throw for an unsupported package manager', () => {
      expect(() => getCiInstallCommand(unsupported)).toThrow('Unsupported package manager: pnpm');
    });
  });

  describe('getDockerBaseImage', () => {
    it('should return the base image for each package manager', () => {
      expect(getDockerBaseImage('bun')).toBe('oven/bun:1-slim');
      expect(getDockerBaseImage('npm')).toBe('node:24-slim');
    });

    it('should throw for an unsupported package manager', () => {
      expect(() => getDockerBaseImage(unsupported)).toThrow('Unsupported package manager: pnpm');
    });
  });

  describe('getLockfileName', () => {
    it('should return the lockfile name for each package manager', () => {
      expect(getLockfileName('bun')).toBe('bun.lock');
      expect(getLockfileName('npm')).toBe('package-lock.json');
    });

    it('should throw for an unsupported package manager', () => {
      expect(() => getLockfileName(unsupported)).toThrow('Unsupported package manager: pnpm');
    });
  });
});
