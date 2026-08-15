import { Tree } from '@nx/devkit';
import { HapiMigrationResult } from './hapi-migration';

/**
 * Reference shape for a HapiMigration implementation module. A real custom
 * step replaces this body with the work that version pair needs.
 */
export default async function update(
  tree: Tree,
  options: { project?: string } = {},
): Promise<HapiMigrationResult> {
  tree.write(
    '.nx-fhir-custom-step',
    `custom migration step ran for ${options.project ?? 'every project'}`,
  );
  return {
    success: true,
    hasConflicts: false,
    projectResults: [],
    skippedProjects: [],
  };
}
