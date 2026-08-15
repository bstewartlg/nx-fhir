import { describe, it, expect } from 'vitest';
import {
  buildBridgeMigration,
  buildMigrationPath,
  validateMigrationPath,
  getReachableVersions,
  HAPI_MIGRATIONS,
} from './hapi-migration-resolver';
import { SUPPORTED_HAPI_VERSIONS } from '../constants/versions';

const FULL_CHAIN = [
  '8.0.0',
  '8.0.0-1',
  '8.0.0-2',
  '8.2.0-1',
  '8.2.0-2',
  '8.4.0-1',
  '8.4.0-2',
  '8.4.0-3',
  '8.6.0-1',
  '8.6.5-1',
  '8.8.0-1',
  '8.10.0-1',
  '8.10.0-2',
  '8.10.0-3',
];

describe('hapi-migration-resolver', () => {
  describe('buildMigrationPath', () => {
    it('should find direct migration path', () => {
      const path = buildMigrationPath('8.0.0', '8.0.0-1');

      expect(path).toHaveLength(1);
      expect(path[0].from).toBe('8.0.0');
      expect(path[0].to).toBe('8.0.0-1');
    });

    it('should find multi-step migration path', () => {
      const path = buildMigrationPath('8.0.0', '8.0.0-2');

      expect(path.map((m) => [m.from, m.to])).toEqual([
        ['8.0.0', '8.0.0-1'],
        ['8.0.0-1', '8.0.0-2'],
      ]);
    });

    it('should find full migration chain from 8.0.0 to 8.10.0-3', () => {
      const path = buildMigrationPath('8.0.0', '8.10.0-3');

      expect(path).toHaveLength(13);
      expect(path[0].from).toBe('8.0.0');
      expect(path[0].to).toBe('8.0.0-1');
      expect(path[12].from).toBe('8.10.0-2');
      expect(path[12].to).toBe('8.10.0-3');
    });

    it('should throw error when no path exists', () => {
      expect(() => buildMigrationPath('8.2.0-2', '9.0.0')).toThrow(
        'No migration path found'
      );
    });

    it('should bridge a source version outside the graph to the nearest tested release above it', () => {
      const path = buildMigrationPath('7.0.0', '8.0.0-1');

      expect(path).toHaveLength(2);
      expect(path[0]).toMatchObject({
        from: '7.0.0',
        to: '8.0.0',
        bridge: true,
      });
      expect(path[1]).toMatchObject({ from: '8.0.0', to: '8.0.0-1' });
    });

    it('should bridge upward, never downward, for an uncurated version below the tested range', () => {
      const path = buildMigrationPath('7.4.0', '8.0.0-2');

      expect(path[0]).toMatchObject({
        from: '7.4.0',
        to: '8.0.0',
        bridge: true,
      });
      expect(path.map((m) => m.to)).toEqual(['8.0.0', '8.0.0-1', '8.0.0-2']);
    });

    it('migrates through the curated 8.6.5-1 release in single steps', () => {
      const toRelease = buildMigrationPath('8.6.0-1', '8.6.5-1');
      expect(toRelease).toHaveLength(1);
      expect(toRelease[0].bridge).toBeUndefined();

      const fromRelease = buildMigrationPath('8.6.5-1', '8.8.0-1');
      expect(fromRelease).toHaveLength(1);
      expect(fromRelease[0].bridge).toBeUndefined();
    });

    it('should support a bridge directly to the target version', () => {
      const path = buildMigrationPath('7.6.0', '8.0.0');

      expect(path).toEqual([
        { from: '7.6.0', to: '8.0.0', bridge: true },
      ]);
    });

    it('should return an empty path when source and target are the same graph version', () => {
      expect(buildMigrationPath('8.4.0-2', '8.4.0-2')).toEqual([]);
    });

    it('should return an empty path when source and target are the same untested release', () => {
      expect(buildMigrationPath('7.6.0', '7.6.0')).toEqual([]);
    });

    it('should throw error for a source version newer than every tested release', () => {
      expect(() => buildMigrationPath('9.0.0-1', '8.4.0-2')).toThrow(
        'No migration path found'
      );
    });
  });

  describe('buildBridgeMigration', () => {
    it('returns undefined for a version already in the migration graph', () => {
      expect(buildBridgeMigration('8.4.0-2')).toBeUndefined();
      expect(buildBridgeMigration('8.10.0-3')).toBeUndefined();
    });

    it('returns undefined for a version newer than every curated release', () => {
      expect(buildBridgeMigration('9.0.0-1')).toBeUndefined();
    });

    it('returns undefined for every curated release', () => {
      for (const release of SUPPORTED_HAPI_VERSIONS) {
        expect(buildBridgeMigration(release)).toBeUndefined();
      }
    });

    it('bridges an untested release to the nearest curated version above it', () => {
      expect(buildBridgeMigration('7.6.0')).toEqual({
        from: '7.6.0',
        to: '8.0.0',
        bridge: true,
      });
      expect(buildBridgeMigration('7.4.0')).toEqual({
        from: '7.4.0',
        to: '8.0.0',
        bridge: true,
      });
    });
  });

  describe('validateMigrationPath', () => {
    it('should validate existing path', () => {
      const result = validateMigrationPath('8.0.0', '8.0.0-1');

      expect(result.valid).toBe(true);
      expect(result.path).toHaveLength(1);
      expect(result.error).toBeUndefined();
    });

    it('should invalidate non-existent path', () => {
      const result = validateMigrationPath('8.2.0-2', '9.0.0');

      expect(result.valid).toBe(false);
      expect(result.path).toBeUndefined();
      expect(result.error).toContain('No migration path found');
    });
  });

  describe('getReachableVersions', () => {
    it('should find all reachable versions from 8.2.0-2', () => {
      const reachable = getReachableVersions('8.2.0-2');

      expect(reachable).toContain('8.4.0-2');
      expect(reachable).not.toContain('8.6.0');
    });

    it('should find reachable versions from 8.6.0-1', () => {
      const reachable = getReachableVersions('8.6.0-1');

      expect(reachable).toHaveLength(5);
      expect(reachable).toContain('8.6.5-1');
      expect(reachable).toContain('8.8.0-1');
      expect(reachable).toContain('8.10.0-1');
      expect(reachable).toContain('8.10.0-2');
      expect(reachable).toContain('8.10.0-3');
    });

    it('should find reachable versions from 8.10.0-2', () => {
      const reachable = getReachableVersions('8.10.0-2');

      expect(reachable).toHaveLength(1);
      expect(reachable).toContain('8.10.0-3');
    });

    it('should return empty array for version with no migrations', () => {
      const reachable = getReachableVersions('9.0.0');

      expect(reachable).toHaveLength(0);
    });

    it('should reach the full tested chain from a bridged version', () => {
      expect(getReachableVersions('7.6.0')).toEqual(FULL_CHAIN);
    });

    it('should order versions oldest to newest so the last entry is the endpoint', () => {
      const reachable = getReachableVersions('8.2.0-2');

      expect(reachable).toEqual([
        '8.4.0-1',
        '8.4.0-2',
        '8.4.0-3',
        '8.6.0-1',
        '8.6.5-1',
        '8.8.0-1',
        '8.10.0-1',
        '8.10.0-2',
        '8.10.0-3',
      ]);
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

    it('leaves every curated step on the generic three-way merge', () => {
      for (const migration of HAPI_MIGRATIONS) {
        expect(migration.implementation).toBeUndefined();
      }
    });

    it('steps through every curated release in order without skipping one', () => {
      expect(HAPI_MIGRATIONS.map((m) => m.from)).toEqual(
        FULL_CHAIN.slice(0, -1),
      );
      expect(HAPI_MIGRATIONS.map((m) => m.to)).toEqual(FULL_CHAIN.slice(1));
      expect(SUPPORTED_HAPI_VERSIONS).toEqual(FULL_CHAIN);
    });

  });
});
