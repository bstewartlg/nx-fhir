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
  });
});
