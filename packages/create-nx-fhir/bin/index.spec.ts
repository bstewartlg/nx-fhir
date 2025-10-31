import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPackageManagerAvailable,
  resolveDirectory,
  resolvePackageManager,
  sanitizeDirectory,
  SUPPORTED_PACKAGE_MANAGERS,
} from './index';
import type { CliArgs, PackageManager } from './index';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
}));

vi.mock('create-nx-workspace', () => ({
  createWorkspace: vi.fn(),
}));

vi.mock('@nx/devkit', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  default: {
    execSync: vi.fn(),
  },
}));

describe('create-nx-fhir CLI utilities', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  describe('sanitizeDirectory', () => {
    it('should convert to lowercase', () => {
      expect(sanitizeDirectory('MyWorkspace')).toBe('myworkspace');
      expect(sanitizeDirectory('TEST-WORKSPACE')).toBe('test-workspace');
    });

    it('should replace spaces with dashes', () => {
      expect(sanitizeDirectory('my new workspace')).toBe('my-new-workspace');
      expect(sanitizeDirectory('test   workspace')).toBe('test-workspace');
    });

    it('should replace special characters with dashes', () => {
      expect(sanitizeDirectory('my@workspace')).toBe('my-workspace');
      expect(sanitizeDirectory('test!workspace#')).toBe('test-workspace');
      expect(sanitizeDirectory('work_space')).toBe('work-space');
    });

    it('should collapse multiple dashes into one', () => {
      expect(sanitizeDirectory('my---workspace')).toBe('my-workspace');
      expect(sanitizeDirectory('test--workspace')).toBe('test-workspace');
    });

    it('should remove leading and trailing dashes', () => {
      expect(sanitizeDirectory('---my-workspace---')).toBe('my-workspace');
      expect(sanitizeDirectory('-test-')).toBe('test');
    });

    it('should trim whitespace', () => {
      expect(sanitizeDirectory('  my-workspace  ')).toBe('my-workspace');
      expect(sanitizeDirectory('\ntest\n')).toBe('test');
    });

    it('should handle complex combinations', () => {
      expect(sanitizeDirectory('  My New Workspace!@#  ')).toBe(
        'my-new-workspace',
      );
      expect(sanitizeDirectory('TEST___WORKSPACE')).toBe('test-workspace');
    });

    it('should preserve valid alphanumeric characters and dashes', () => {
      expect(sanitizeDirectory('test-workspace-123')).toBe(
        'test-workspace-123',
      );
      expect(sanitizeDirectory('my-cool-app-v2')).toBe('my-cool-app-v2');
    });

    it('should handle empty strings after sanitization', () => {
      expect(sanitizeDirectory('   ')).toBe('');
      expect(sanitizeDirectory('---')).toBe('');
      expect(sanitizeDirectory('@@@')).toBe('');
    });

    it('should handle strings with only numbers', () => {
      expect(sanitizeDirectory('123')).toBe('123');
      expect(sanitizeDirectory('123-456')).toBe('123-456');
    });

    it('should handle unicode characters by removing non-ASCII', () => {
      expect(sanitizeDirectory('café')).toBe('caf');
      expect(sanitizeDirectory('über-app')).toBe('ber-app');
    });
  });

  describe('resolveDirectory', () => {
    it('should use directory option when provided', async () => {
      const args: CliArgs = { directory: 'my-workspace' };
      const result = await resolveDirectory(args);
      expect(result).toBe('my-workspace');
    });

    it('should sanitize directory option', async () => {
      const args: CliArgs = { directory: 'My Workspace!' };
      const result = await resolveDirectory(args);
      expect(result).toBe('my-workspace');
    });

    it('should use positional argument when provided', async () => {
      const args: CliArgs = { _: ['test-workspace'] };
      const result = await resolveDirectory(args);
      expect(result).toBe('test-workspace');
    });

    it('should sanitize positional argument', async () => {
      const args: CliArgs = { _: ['Test Workspace!'] };
      const result = await resolveDirectory(args);
      expect(result).toBe('test-workspace');
    });

    it('should prefer directory option over positional argument', async () => {
      const args: CliArgs = {
        directory: 'option-workspace',
        _: ['positional-workspace'],
      };
      const result = await resolveDirectory(args);
      expect(result).toBe('option-workspace');
    });

    it('should prompt when no directory or positional arg provided', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('prompted-workspace');

      const args: CliArgs = {};
      const result = await resolveDirectory(args);

      expect(result).toBe('prompted-workspace');
      expect(input).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Workspace directory:',
          validate: expect.any(Function),
        }),
      );
    });

    it('should prompt when positional argument is not a string', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('prompted-workspace');

      const args: CliArgs = { _: [123] };
      const result = await resolveDirectory(args);

      expect(result).toBe('prompted-workspace');
    });

    it('should validate directory starts with a letter', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('workspace');

      const args: CliArgs = {};
      await resolveDirectory(args);

      const validateFn = vi.mocked(input).mock.calls[0][0].validate;

      expect(validateFn('123-workspace')).toBe(
        'Directory must start with a letter and contain only lowercase letters, numbers and dashes.',
      );
      expect(validateFn('workspace-123')).toBe(true);
      expect(validateFn('a-123')).toBe(true);
    });

    it('should validate directory is not empty after sanitization', async () => {
      const { input } = await import('@inquirer/prompts');
      vi.mocked(input).mockResolvedValue('workspace');

      const args: CliArgs = {};
      await resolveDirectory(args);

      const validateFn = vi.mocked(input).mock.calls[0][0].validate;

      expect(validateFn('   ')).toBe(
        'Please enter a valid directory (alphanumeric and dashes).',
      );
      expect(validateFn('---')).toBe(
        'Please enter a valid directory (alphanumeric and dashes).',
      );
      expect(validateFn('workspace')).toBe(true);
    });

    it('should handle complex directory names', async () => {
      const args: CliArgs = { directory: '  My Super Cool Workspace v2!  ' };
      const result = await resolveDirectory(args);
      expect(result).toBe('my-super-cool-workspace-v2');
    });

    it('should handle directory with multiple special characters', async () => {
      const args: CliArgs = { directory: 'test@#$%workspace^&*()123' };
      const result = await resolveDirectory(args);
      expect(result).toBe('test-workspace-123');
    });
  });

  describe('isPackageManagerAvailable', () => {
    it('should return true for supported package manager', () => {
      SUPPORTED_PACKAGE_MANAGERS.forEach((pm) => {
        expect(isPackageManagerAvailable(pm)).toBe(true);
      });
    });

    it('should return false for unsupported package manager', () => {
      expect(
        isPackageManagerAvailable('nonexistent-pm' as PackageManager),
      ).toBe(false);
    });
  });

  describe('resolvePackageManager', () => {
    it('should return requested package manager if available', () => {
      SUPPORTED_PACKAGE_MANAGERS.forEach((pm) => {
        const result = resolvePackageManager(pm);
        expect(result).toBe(pm);
      });
    });

    it('should default to bun if no requested package manager provided and bun is available', () => {
      const result = resolvePackageManager();
      expect(result).toBe('bun');
    });

    it('should return first available supported package manager if requested is not available', () => {
      const result = resolvePackageManager('nonexistent-pm' as PackageManager);
      expect(SUPPORTED_PACKAGE_MANAGERS).toContain(result);
    });
  });
});
