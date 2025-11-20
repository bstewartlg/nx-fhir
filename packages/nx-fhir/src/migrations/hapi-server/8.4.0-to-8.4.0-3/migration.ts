import { logger, Tree, getProjects, updateProjectConfiguration, updateJson } from '@nx/devkit';
import { downloadAndExtract } from '../../../generators/server/server';
import { existsSync, rmSync } from 'fs';
import { UpdateServerGeneratorSchema } from '../../../generators/update-server/schema';
import {
  migrateWithThreeWayMerge,
  logMigrationSummary,
} from '../../../shared/utils/merge';
import { ServerProjectConfiguration } from '../../../shared/models';
import { PLUGIN_VERSION } from '../../../shared/constants/versions';
import { confirm } from '@inquirer/prompts';

export default async function update(
  tree: Tree,
  options: UpdateServerGeneratorSchema = {},
) {
  // Update Nx dependencies
  updateJson(tree, 'package.json', (json) => {
    const targetNxVersion = '22.1.0';

    if (json.dependencies) {
      for (const key of Object.keys(json.dependencies)) {
        if (key === 'nx' || key.startsWith('@nx/')) {
          json.dependencies[key] = targetNxVersion;
        }
      }
    }
    if (json.devDependencies) {
      for (const key of Object.keys(json.devDependencies)) {
        if (key === 'nx' || key.startsWith('@nx/')) {
          json.devDependencies[key] = targetNxVersion;
        }
      }
    }
    return json;
  });
  logger.info('Updated Nx dependencies to 22.1.0');

  let projectsToUpdate: string[] = [];

  if (options.project) {
    projectsToUpdate = [options.project];
  } else {
    const projects = getProjects(tree);
    for (const [projectName, config] of projects) {
      const serverConfig = config as ServerProjectConfiguration;
      if (serverConfig.hapiReleaseVersion === '8.4.0') {
        projectsToUpdate.push(projectName);
      }
    }
  }

  if (projectsToUpdate.length === 0) {
    logger.info('No projects found to update.');
    return;
  }

  const confirmedProjects: string[] = [];
  for (const projectName of projectsToUpdate) {
    const shouldUpdate = await confirm({
      message: `Do you want to update the HAPI server for project "${projectName}" to 8.4.0-3?`,
      default: true,
    });
    if (shouldUpdate) {
      confirmedProjects.push(projectName);
    }
  }

  if (confirmedProjects.length === 0) {
    logger.info('No projects confirmed for update.');
    return;
  }

  let tempDirOld: string;
  let tempDirNew: string;

  try {
    // Download both old and new versions for comparison
    logger.info('Downloading HAPI FHIR 8.4.0 (base version)...');
    tempDirOld = await downloadAndExtract('8.4.0');

    logger.info('Downloading HAPI FHIR 8.4.0-3 (new version)...');
    tempDirNew = await downloadAndExtract('8.4.0-3');

    for (const projectName of confirmedProjects) {
      logger.info(
        `Running migration: Update project from 8.4.0 to 8.4.0-3 in ${projectName}`,
      );

      const projectConfig = getProjects(tree).get(
        projectName,
      ) as ServerProjectConfiguration;
      if (!projectConfig) {
        logger.warn(`Project ${projectName} not found, skipping.`);
        continue;
      }

      // Perform three-way merge
      const summary = migrateWithThreeWayMerge(
        tree,
        projectConfig.root,
        tempDirOld,
        tempDirNew,
        '8.4.0',
        '8.4.0-3',
      );

      // Update project configuration
      projectConfig.hapiReleaseVersion = '8.4.0-3';
      projectConfig.pluginVersion = PLUGIN_VERSION;
      updateProjectConfiguration(tree, projectName, projectConfig);

      // Log summary
      logMigrationSummary(summary, '8.4.0', '8.4.0-3');

      logger.info(`\n✅ Migration complete for ${projectName}!`);
    }
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
