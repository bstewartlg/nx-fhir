import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getInstallCommand,
  getListCommand,
  getRunCommand,
  getExecuteCommand} from './package-manager';

vi.mock('child_process');

describe('package-manager utils', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.npm_config_user_agent;
  });

  afterEach(() => {
    process.env = originalEnv;
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
  });

  describe('getListCommand', () => {
    it('should return correct bun list command', () => {
      expect(getListCommand('bun', 'some-package')).toMatch(/^bun pm ls \| (grep|findstr) some-package$/);
    });

    it('should return correct npm list command', () => {
      expect(getListCommand('npm', 'some-package')).toBe('npm ls some-package');
    });
  });

  describe('getRunCommand', () => {
    it('should return correct bun run command', () => {
      expect(getRunCommand('bun', 'test')).toBe('bun run test');
    });

    it('should return correct npm run command', () => {
      expect(getRunCommand('npm', 'test')).toBe('npm run test');
    });
  });

  describe('getExecuteCommand', () => {
    it('should return correct bunx command', () => {
      expect(getExecuteCommand('bun', 'some-cli')).toBe('bunx some-cli');
    });

    it('should return correct npx command', () => {
      expect(getExecuteCommand('npm', 'some-cli')).toBe('npx some-cli');
    });
  });
});
