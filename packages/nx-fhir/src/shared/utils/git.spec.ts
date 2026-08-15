import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import {
  isGitRepositoryClean,
  ensureGitRepositoryClean,
  getUncommittedFiles,
} from './git';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('git-utils', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  describe('isGitRepositoryClean', () => {
    it('should return true for clean repository', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(''); // git status

      const result = isGitRepositoryClean('/workspace');

      expect(result).toBe(true);
    });

    it('should return false for dirty repository', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(' M file.txt\n'); // git status

      const result = isGitRepositoryClean('/workspace');

      expect(result).toBe(false);
    });

    it('should return false if git is not available', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('git not found');
      });

      const result = isGitRepositoryClean('/workspace');

      expect(result).toBe(false);
    });

    it('should verify the repository before reading its status', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(''); // git status

      isGitRepositoryClean('/workspace');

      expect(execSync).toHaveBeenNthCalledWith(1, 'git rev-parse --git-dir', {
        cwd: '/workspace',
        stdio: 'pipe',
      });
      expect(execSync).toHaveBeenNthCalledWith(2, 'git status --porcelain', {
        cwd: '/workspace',
        encoding: 'utf-8',
      });
    });

    it('should return true when only nx migrate files changed and they are excluded', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(
        ' M package.json\n' +
        ' M bun.lock\n' +
        ' M migrations.json\n'
      );

      expect(isGitRepositoryClean('/workspace', true)).toBe(true);
    });

    it('should treat nested nx migrate files as expected changes', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(
        ' M apps/server/package.json\n' +
        ' M apps/frontend/package-lock.json\n'
      );

      expect(isGitRepositoryClean('/workspace', true)).toBe(true);
    });

    it('should return false when a file outside the nx migrate set changed', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(
        ' M package.json\n' +
        ' M src/main.ts\n'
      );

      expect(isGitRepositoryClean('/workspace', true)).toBe(false);
    });

    it('should not treat a file that merely ends with an expected name as expected', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(' M my-package.json\n');

      expect(isGitRepositoryClean('/workspace', true)).toBe(false);
    });
  });

  describe('ensureGitRepositoryClean', () => {
    it('should not throw for clean repository', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(''); // git status

      expect(() => {
        ensureGitRepositoryClean('/workspace');
      }).not.toThrow();
    });

    it('should throw for dirty repository', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(' M file.txt\n'); // git status

      expect(() => {
        ensureGitRepositoryClean('/workspace');
      }).toThrow('Git repository has uncommitted changes');
    });

    it('should not throw when force is true', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(' M file.txt\n'); // git status

      expect(() => {
        ensureGitRepositoryClean('/workspace', true);
      }).not.toThrow();
    });

    it('should not run git at all when force is true', () => {
      ensureGitRepositoryClean('/workspace', true);

      expect(execSync).not.toHaveBeenCalled();
    });

    it('should not throw when only nx migrate files changed and they are excluded', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(' M package.json\n M bun.lock\n');

      expect(() => {
        ensureGitRepositoryClean('/workspace', false, true);
      }).not.toThrow();
    });

    it('should report that nx migrate files were excluded when it throws', () => {
      vi.mocked(execSync).mockReturnValueOnce(''); // git rev-parse
      vi.mocked(execSync).mockReturnValueOnce(' M src/main.ts\n');

      expect(() => {
        ensureGitRepositoryClean('/workspace', false, true);
      }).toThrow('Git repository has uncommitted changes (excluding nx migrate files).');
    });
  });

  describe('getUncommittedFiles', () => {
    it('should return list of uncommitted files', () => {
      vi.mocked(execSync).mockReturnValueOnce(
        ' M file1.txt\n' +
        'A  file2.ts\n' +
        '?? file3.js\n'
      );

      const files = getUncommittedFiles('/workspace');

      expect(files).toEqual(['file1.txt', 'file2.ts', 'file3.js']);
    });

    it('should return empty array if git not available', () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('git not found');
      });

      const files = getUncommittedFiles('/workspace');

      expect(files).toEqual([]);
    });

    it('should read the status from the given workspace root', () => {
      vi.mocked(execSync).mockReturnValueOnce('');

      getUncommittedFiles('/some/workspace');

      expect(execSync).toHaveBeenCalledWith('git status --porcelain', {
        cwd: '/some/workspace',
        encoding: 'utf-8',
      });
    });

    it('should drop nx migrate files when they are excluded', () => {
      vi.mocked(execSync).mockReturnValueOnce(
        ' M package.json\n' +
        ' M apps/server/bun.lock\n' +
        ' M src/main.ts\n'
      );

      const files = getUncommittedFiles('/workspace', true);

      expect(files).toEqual(['src/main.ts']);
    });

    it('should keep nx migrate files when they are not excluded', () => {
      vi.mocked(execSync).mockReturnValueOnce(' M package.json\n M src/main.ts\n');

      const files = getUncommittedFiles('/workspace');

      expect(files).toEqual(['package.json', 'src/main.ts']);
    });

    it('should return an empty list for a clean repository', () => {
      vi.mocked(execSync).mockReturnValueOnce('');

      expect(getUncommittedFiles('/workspace')).toEqual([]);
    });
  });
});
