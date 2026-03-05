import { describe, it, expect } from 'vitest';
import {
  validateFrontendMigrationPath,
  getReachableFrontendVersions,
  CURRENT_FRONTEND_VERSION,
} from './frontend-migration-resolver';

describe('frontend-migration-resolver', () => {
  describe('validateFrontendMigrationPath', () => {
    it('should validate same version as valid with empty path', () => {
      const result = validateFrontendMigrationPath(
        CURRENT_FRONTEND_VERSION,
        CURRENT_FRONTEND_VERSION
      );

      expect(result.valid).toBe(true);
      expect(result.path).toHaveLength(0);
    });

    it('should validate migration to current version', () => {
      const result = validateFrontendMigrationPath('0.1.0', CURRENT_FRONTEND_VERSION);

      expect(result.valid).toBe(true);
      expect(result.path).toHaveLength(1);
      expect(result.path![0]).toEqual({ from: '0.1.0', to: CURRENT_FRONTEND_VERSION });
    });

    it('should reject migration to a version that is not current', () => {
      const result = validateFrontendMigrationPath('0.1.0', '9.0.0');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Can only migrate to current version');
    });
  });

  describe('getReachableFrontendVersions', () => {
    it('should return current version when project is behind', () => {
      const reachable = getReachableFrontendVersions('0.1.0');
      expect(reachable).toEqual([CURRENT_FRONTEND_VERSION]);
    });

    it('should return empty array when already at current version', () => {
      const reachable = getReachableFrontendVersions(CURRENT_FRONTEND_VERSION);
      expect(reachable).toHaveLength(0);
    });
  });

  describe('CURRENT_FRONTEND_VERSION', () => {
    it('should be a valid semver-like string', () => {
      expect(CURRENT_FRONTEND_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
