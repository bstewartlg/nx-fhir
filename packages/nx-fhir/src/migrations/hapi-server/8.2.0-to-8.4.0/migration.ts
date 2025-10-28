import { logger, Tree, getProjects, updateProjectConfiguration } from '@nx/devkit';
import { downloadAndExtract } from '../../../generators/server/server';
import { existsSync, rmSync } from 'fs';
import { UpdateServerGeneratorSchema } from '../../../generators/update-server/schema';
import {
  migrateWithThreeWayMerge,
  logMigrationSummary,
} from '../../../shared/utils/merge';
import { ServerProjectConfiguration } from '../../../shared/models';
import { PLUGIN_VERSION } from '../../../shared/constants/versions';

export default async function update(
  tree: Tree,
  options: UpdateServerGeneratorSchema,
) {
  logger.info(
    `Running migration: Update project from 8.2.0 to 8.4.0 in ${options.project}`,
  );

  const projectConfig = getProjects(tree).get(options.project) as ServerProjectConfiguration;
  if (!projectConfig) {
    throw new Error(`Project ${options.project} not found`);
  }

  let tempDirOld: string;
  let tempDirNew: string;

  try {
    // Download both old and new versions for comparison
    logger.info('Downloading HAPI FHIR 8.2.0 (base version)...');
    tempDirOld = await downloadAndExtract('8.2.0');

    logger.info('Downloading HAPI FHIR 8.4.0 (new version)...');
    tempDirNew = await downloadAndExtract('8.4.0');

    // Perform three-way merge
    const summary = migrateWithThreeWayMerge(
      tree,
      projectConfig.root,
      tempDirOld,
      tempDirNew,
      '8.2.0',
      '8.4.0',
    );

    // Update project configuration
    projectConfig.hapiReleaseVersion = '8.4.0';
    projectConfig.pluginVersion = PLUGIN_VERSION;
    updateProjectConfiguration(tree, options.project, projectConfig);

    // Log summary
    logMigrationSummary(summary, '8.2.0', '8.4.0');

    logger.info('\n✅ Migration complete!');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Migration failed: ${errorMessage}`);
    throw error;
  } finally {
    // Clean up temporary directories
    if (tempDirOld && existsSync(tempDirOld)) {
      logger.info(`Cleaning up temporary directory ${tempDirOld}`);
      rmSync(tempDirOld, { recursive: true, force: true });
    }
    if (tempDirNew && existsSync(tempDirNew)) {
      logger.info(`Cleaning up temporary directory ${tempDirNew}`);
      rmSync(tempDirNew, { recursive: true, force: true });
    }
  }
}
