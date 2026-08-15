import { SUPPORTED_HAPI_VERSIONS } from '../constants/versions';

/**
 * Migration metadata for HAPI FHIR server version updates
 */
export interface HapiMigration {
  /** Source version (e.g., "8.4.0-1") */
  from: string;
  /** Target version (e.g., "8.4.0-2") */
  to: string;
  /** Module path for a step needing custom logic; a step without one runs the generic three-way merge. */
  implementation?: string;
  /** Whether this migration is still supported for new projects */
  deprecated?: boolean;
  /** Marks a synthesized best-effort step from a release outside the tested graph */
  bridge?: boolean;
}

/**
 * Registry of the migrations between consecutive curated releases.
 * A recorded release upgrades through the chain.
 */
export const HAPI_MIGRATIONS: HapiMigration[] = [
  { from: '8.0.0', to: '8.0.0-1' },
  { from: '8.0.0-1', to: '8.0.0-2' },
  { from: '8.0.0-2', to: '8.2.0-1' },
  { from: '8.2.0-1', to: '8.2.0-2' },
  { from: '8.2.0-2', to: '8.4.0-1' },
  { from: '8.4.0-1', to: '8.4.0-2' },
  { from: '8.4.0-2', to: '8.4.0-3' },
  { from: '8.4.0-3', to: '8.6.0-1' },
  { from: '8.6.0-1', to: '8.6.5-1' },
  { from: '8.6.5-1', to: '8.8.0-1' },
  { from: '8.8.0-1', to: '8.10.0-1' },
  { from: '8.10.0-1', to: '8.10.0-2' },
  { from: '8.10.0-2', to: '8.10.0-3' }
];

/**
 * Find a direct migration path between two versions
 */
function findDirectMigration(from: string, to: string): HapiMigration | undefined {
  return HAPI_MIGRATIONS.find(m => m.from === from && m.to === to);
}

const MIGRATION_GRAPH_VERSIONS = new Set(
  HAPI_MIGRATIONS.flatMap(m => [m.from, m.to])
);

/**
 * Builds the step that carries a release outside the migration graph to the
 * nearest curated version above it. The step merges with the release's own
 * image as the base, so it works for any published starter image but is not
 * a tested migration. Returns undefined for versions already in the graph
 * and for versions newer than every curated release.
 */
export function buildBridgeMigration(
  fromVersion: string
): HapiMigration | undefined {
  if (MIGRATION_GRAPH_VERSIONS.has(fromVersion)) {
    return undefined;
  }
  const target = [...SUPPORTED_HAPI_VERSIONS]
    .sort(compareHapiVersions)
    .find(v => compareHapiVersions(v, fromVersion) > 0);
  return target ? { from: fromVersion, to: target, bridge: true } : undefined;
}

/**
 * Build a migration path from source to target version using graph traversal
 * Returns an ordered array of migrations to execute
 */
export function buildMigrationPath(
  fromVersion: string,
  toVersion: string
): HapiMigration[] {
  // Same-version requests are a no-op before bridging so a release outside
  // the graph is not carried through a bridge it does not need.
  if (fromVersion === toVersion) {
    return [];
  }

  // A version outside the graph first bridges to the nearest curated version
  // above it, then follows the tested chain.
  const bridge = buildBridgeMigration(fromVersion);
  if (bridge) {
    return bridge.to === toVersion
      ? [bridge]
      : [bridge, ...buildMigrationPath(bridge.to, toVersion)];
  }

  // Direct migration exists
  const directMigration = findDirectMigration(fromVersion, toVersion);
  if (directMigration) {
    return [directMigration];
  }

  // Build a graph of version transitions
  const graph = new Map<string, HapiMigration[]>();
  for (const migration of HAPI_MIGRATIONS) {
    const migrationsFromVersion = graph.get(migration.from) ?? [];
    migrationsFromVersion.push(migration);
    graph.set(migration.from, migrationsFromVersion);
  }

  // BFS to find shortest path
  const queue: { version: string; path: HapiMigration[] }[] = [
    { version: fromVersion, path: [] },
  ];
  const visited = new Set<string>([fromVersion]);

  let current: { version: string; path: HapiMigration[] } | undefined;
  while ((current = queue.shift()) !== undefined) {
    // Found the target
    if (current.version === toVersion) {
      return current.path;
    }

    // Explore neighbors
    const nextMigrations = graph.get(current.version) || [];
    for (const migration of nextMigrations) {
      if (!visited.has(migration.to)) {
        visited.add(migration.to);
        queue.push({
          version: migration.to,
          path: [...current.path, migration],
        });
      }
    }
  }

  // No path found
  throw new Error(
    `No migration path found from ${fromVersion} to ${toVersion}. ` +
    `Available migrations: ${HAPI_MIGRATIONS.map(m => `${m.from}→${m.to}`).join(', ')}`
  );
}

/**
 * Validate that a migration path exists before attempting it
 */
export function validateMigrationPath(
  fromVersion: string,
  toVersion: string
): { valid: boolean; path?: HapiMigration[]; error?: string } {
  try {
    const path = buildMigrationPath(fromVersion, toVersion);
    return { valid: true, path };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get all versions that are reachable from a given version
 */
export function getReachableVersions(fromVersion: string): string[] {
  const bridge = buildBridgeMigration(fromVersion);
  const startVersion = bridge ? bridge.to : fromVersion;

  const reachable = new Set<string>(bridge ? [bridge.to] : []);
  const graph = new Map<string, HapiMigration[]>();

  for (const migration of HAPI_MIGRATIONS) {
    const migrationsFromVersion = graph.get(migration.from) ?? [];
    migrationsFromVersion.push(migration);
    graph.set(migration.from, migrationsFromVersion);
  }

  const queue = [startVersion];
  const visited = new Set([startVersion]);

  let current: string | undefined;
  while ((current = queue.shift()) !== undefined) {
    const nextMigrations = graph.get(current) || [];

    for (const migration of nextMigrations) {
      if (!visited.has(migration.to)) {
        visited.add(migration.to);
        reachable.add(migration.to);
        queue.push(migration.to);
      }
    }
  }

  return Array.from(reachable).sort(compareHapiVersions);
}

/**
 * Orders HAPI starter versions from oldest to newest by comparing each dotted
 * or dashed segment as a number. The dashed suffix is a later image revision,
 * so semver, which reads it as a prerelease, must not be used here.
 */
export function compareHapiVersions(a: string, b: string): number {
  const partsA = a.split(/[.-]/).map(Number);
  const partsB = b.split(/[.-]/).map(Number);
  const length = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < length; i++) {
    const difference = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}
