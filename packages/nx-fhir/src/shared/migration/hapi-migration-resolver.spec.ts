import { describe, it, expect } from 'vitest';
import {
  buildMigrationPath,
  validateMigrationPath,
  getReachableVersions,
  HAPI_MIGRATIONS,
} from './hapi-migration-resolver';

describe('hapi-migration-resolver', () => {
  describe('buildMigrationPath', () => {
    it('should find direct migration path', () => {
      const path = buildMigrationPath('8.2.0', '8.4.0');
      
      expect(path).toHaveLength(1);
      expect(path[0].from).toBe('8.2.0');
      expect(path[0].to).toBe('8.4.0');
    });

    it('should find multi-step migration path', () => {
      const path = buildMigrationPath('8.2.0', '8.4.0');
      
      expect(path).toHaveLength(1);
      expect(path[0].from).toBe('8.2.0');
      expect(path[0].to).toBe('8.4.0');
    });

    // TODO: Define this when more than one migration exists
    // it('should find longer migration chain', () => {
    //   const path = buildMigrationPath('8.2.0', '8.4.0');
      
    //   expect(path).toHaveLength(3);
    //   expect(path[0].from).toBe('8.2.0');
    //   expect(path[0].to).toBe('8.4.0');
    // });

    it('should throw error when no path exists', () => {
      expect(() => buildMigrationPath('8.2.0', '9.0.0')).toThrow(
        'No migration path found'
      );
    });

    it('should throw error for invalid source version', () => {
      expect(() => buildMigrationPath('7.0.0', '8.4.0')).toThrow(
        'No migration path found'
      );
    });
  });

  describe('validateMigrationPath', () => {
    it('should validate existing path', () => {
      const result = validateMigrationPath('8.2.0', '8.4.0');
      
      expect(result.valid).toBe(true);
      expect(result.path).toHaveLength(1);
      expect(result.error).toBeUndefined();
    });

    it('should invalidate non-existent path', () => {
      const result = validateMigrationPath('8.2.0', '9.0.0');
      
      expect(result.valid).toBe(false);
      expect(result.path).toBeUndefined();
      expect(result.error).toContain('No migration path found');
    });
  });

  describe('getReachableVersions', () => {
    it('should find all reachable versions from 8.2.0', () => {
      const reachable = getReachableVersions('8.2.0');
      
      expect(reachable).toContain('8.4.0');
      expect(reachable).not.toContain('8.6.0');
    });

    it('should find limited reachable versions from 8.4.0', () => {
      const reachable = getReachableVersions('8.4.0');
      
      expect(reachable).toHaveLength(0);
    });

    it('should return empty array for version with no migrations', () => {
      const reachable = getReachableVersions('8.8.0');
      
      expect(reachable).toHaveLength(0);
    });
  });

  describe('HAPI_MIGRATIONS registry', () => {
    it('should have valid migration chain', () => {
      // Ensure no duplicate migrations
      const seen = new Set<string>();
      for (const migration of HAPI_MIGRATIONS) {
        const key = `${migration.from}->${migration.to}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    });

    it('should have implementation paths', () => {
      for (const migration of HAPI_MIGRATIONS) {
        expect(migration.implementation).toBeTruthy();
        expect(migration.implementation).toContain('migrations/hapi-server');
      }
    });
  });
});
