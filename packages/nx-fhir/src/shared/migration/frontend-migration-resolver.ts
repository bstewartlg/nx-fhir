/**
 * Migration metadata for frontend version updates
 */
export interface FrontendMigration {
  /** Source version (e.g., "1.0.0") */
  from: string;
  /** Target version (e.g., "1.1.0") */
  to: string;
  /** Path to the migration implementation */
  implementation: string;
  /** Whether this migration is still supported for new projects */
  deprecated?: boolean;
}

/**
 * Current frontend template version
 * Increment this when making breaking changes to the frontend template
 */
export const CURRENT_FRONTEND_VERSION = '0.2.0';

/**
 * Registry of all frontend version migrations
 * Migrations are kept even when versions are no longer supported for new projects
 * to allow users to upgrade from older versions through a chain
 */
export const FRONTEND_MIGRATIONS: FrontendMigration[] = [];

/**
 * Find a direct migration path between two versions
 */
function findDirectMigration(from: string, to: string): FrontendMigration | undefined {
  return FRONTEND_MIGRATIONS.find(m => m.from === from && m.to === to);
}

/**
 * Build a migration path from source to target version using graph traversal
 * Returns an ordered array of migrations to execute
 */
export function buildFrontendMigrationPath(
  fromVersion: string,
  toVersion: string
): FrontendMigration[] {
  if (fromVersion === toVersion) {
    return [];
  }

  const directMigration = findDirectMigration(fromVersion, toVersion);
  if (directMigration) {
    return [directMigration];
  }

  const graph = new Map<string, FrontendMigration[]>();
  for (const migration of FRONTEND_MIGRATIONS) {
    if (!graph.has(migration.from)) {
      graph.set(migration.from, []);
    }
    graph.get(migration.from)!.push(migration);
  }

  const queue: { version: string; path: FrontendMigration[] }[] = [
    { version: fromVersion, path: [] },
  ];
  const visited = new Set<string>([fromVersion]);

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.version === toVersion) {
      return current.path;
    }

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

  throw new Error(
    `No migration path found from ${fromVersion} to ${toVersion}. ` +
    `Available migrations: ${FRONTEND_MIGRATIONS.map(m => `${m.from}→${m.to}`).join(', ') || 'none'}`
  );
}

/**
 * Validate that a migration path exists before attempting it
 */
export function validateFrontendMigrationPath(
  fromVersion: string,
  toVersion: string
): { valid: boolean; path?: FrontendMigration[]; error?: string } {
  try {
    const path = buildFrontendMigrationPath(fromVersion, toVersion);
    return { valid: true, path };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
