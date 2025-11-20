/**
 * Migration metadata for HAPI FHIR server version updates
 */
export interface HapiMigration {
  /** Source version (e.g., "8.2.0") */
  from: string;
  /** Target version (e.g., "8.4.0") */
  to: string;
  /** Path to the migration implementation */
  implementation: string;
  /** Whether this migration is still supported for new projects */
  deprecated?: boolean;
}

/**
 * Registry of all HAPI FHIR version migrations
 * Migrations are kept even when versions are no longer supported for new projects
 * to allow users to upgrade from older versions through a chain
 */
export const HAPI_MIGRATIONS: HapiMigration[] = [
  {
    from: '8.2.0',
    to: '8.4.0',
    implementation: 'migrations/hapi-server/8.2.0-to-8.4.0/migration'
  },
  {
    from: '8.4.0',
    to: '8.4.0-3',
    implementation: 'migrations/hapi-server/8.4.0-to-8.4.0-3/migration'
  }
];

/**
 * Find a direct migration path between two versions
 */
function findDirectMigration(from: string, to: string): HapiMigration | undefined {
  return HAPI_MIGRATIONS.find(m => m.from === from && m.to === to);
}

/**
 * Build a migration path from source to target version using graph traversal
 * Returns an ordered array of migrations to execute
 */
export function buildMigrationPath(
  fromVersion: string,
  toVersion: string
): HapiMigration[] {
  // Direct migration exists
  const directMigration = findDirectMigration(fromVersion, toVersion);
  if (directMigration) {
    return [directMigration];
  }

  // Build a graph of version transitions
  const graph = new Map<string, HapiMigration[]>();
  for (const migration of HAPI_MIGRATIONS) {
    if (!graph.has(migration.from)) {
      graph.set(migration.from, []);
    }
    graph.get(migration.from)!.push(migration);
  }

  // BFS to find shortest path
  const queue: { version: string; path: HapiMigration[] }[] = [
    { version: fromVersion, path: [] },
  ];
  const visited = new Set<string>([fromVersion]);

  while (queue.length > 0) {
    const current = queue.shift()!;

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
  const reachable = new Set<string>();
  const graph = new Map<string, HapiMigration[]>();
  
  for (const migration of HAPI_MIGRATIONS) {
    if (!graph.has(migration.from)) {
      graph.set(migration.from, []);
    }
    graph.get(migration.from)!.push(migration);
  }

  const queue = [fromVersion];
  const visited = new Set([fromVersion]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextMigrations = graph.get(current) || [];

    for (const migration of nextMigrations) {
      if (!visited.has(migration.to)) {
        visited.add(migration.to);
        reachable.add(migration.to);
        queue.push(migration.to);
      }
    }
  }

  return Array.from(reachable).sort();
}
