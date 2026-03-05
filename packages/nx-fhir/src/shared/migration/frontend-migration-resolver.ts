import { PLUGIN_VERSION } from '../constants/versions';

/**
 * Migration metadata for frontend version updates.
 * Frontend migrations always go directly from the project's current version
 * to the current plugin version via npm download + three-way merge.
 */
export interface FrontendMigration {
  /** Source version */
  from: string;
  /** Target version */
  to: string;
}

/**
 * Current frontend template version, always matches the plugin version.
 * The three-way merge handles no-op diffs when templates haven't changed.
 */
export const CURRENT_FRONTEND_VERSION = PLUGIN_VERSION;

/**
 * Get reachable frontend versions from a given version.
 * If the project isn't already at the current version, the only target is CURRENT_FRONTEND_VERSION.
 */
export function getReachableFrontendVersions(fromVersion: string): string[] {
  if (fromVersion === CURRENT_FRONTEND_VERSION) {
    return [];
  }
  return [CURRENT_FRONTEND_VERSION];
}

/**
 * Validate that a migration path exists between two frontend versions.
 * Frontend migrations are always a single direct step.
 */
export function validateFrontendMigrationPath(
  fromVersion: string,
  toVersion: string
): { valid: boolean; path?: FrontendMigration[]; error?: string } {
  if (fromVersion === toVersion) {
    return { valid: true, path: [] };
  }

  if (toVersion !== CURRENT_FRONTEND_VERSION) {
    return {
      valid: false,
      error: `Can only migrate to current version ${CURRENT_FRONTEND_VERSION}, not ${toVersion}`,
    };
  }

  return {
    valid: true,
    path: [{ from: fromVersion, to: toVersion }],
  };
}
