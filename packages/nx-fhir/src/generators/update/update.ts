import {
  GeneratorCallback,
  Tree,
  logger,
  readJson,
  getProjects,
  updateProjectConfiguration,
} from '@nx/devkit';
import { updateServerGenerator } from '../update-server/update-server';
import { updateFrontendGenerator } from '../update-frontend/update-frontend';
import { PLUGIN_VERSION } from '../../shared/constants/versions';
import { UpdateGeneratorSchema } from './schema';

/**
 * Warns when nx.json has an installation block, which means the workspace runs
 * Nx through the Nx wrapper. The block is left unchanged because a version
 * written into it either reinstalls Nx under a wrapper that cannot run that
 * Nx or changes nothing for the plugin version that is already running.
 * create-nx-fhir converts such a workspace to a package.json install.
 */
function warnAboutNxWrapper(tree: Tree): void {
  if (!tree.exists('nx.json') || !readJson(tree, 'nx.json').installation) {
    return;
  }

  logger.warn(
    'This workspace runs Nx through the Nx wrapper. Run "create-nx-fhir ." to convert it to a package.json install. The nx.json installation block is left unchanged.'
  );
}

/**
 * Updates pluginVersion in project.json for all nx-fhir managed projects
 */
function updateProjectPluginVersions(tree: Tree): boolean {
  const projects = getProjects(tree);
  let updated = false;

  for (const [projectName, projectConfig] of projects) {
    // Check if this is an nx-fhir managed project (has pluginVersion property)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = projectConfig as any;
    if (config.pluginVersion && config.pluginVersion !== PLUGIN_VERSION) {
      config.pluginVersion = PLUGIN_VERSION;
      updateProjectConfiguration(tree, projectName, projectConfig);
      logger.info(
        `Updated pluginVersion to ${PLUGIN_VERSION} in project "${projectName}"`
      );
      updated = true;
    }
  }

  return updated;
}

/**
 * Update generator for nx-fhir plugin.
 *
 * This generator:
 * 1. Warns when the workspace runs Nx through the Nx wrapper
 * 2. Updates pluginVersion in project.json for nx-fhir managed projects
 * 3. Checks for available HAPI server updates
 *
 * Run with: nx g nx-fhir:update
 */
export async function updateGenerator(
  tree: Tree,
  options: UpdateGeneratorSchema,
): Promise<GeneratorCallback | undefined> {
  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`Updating to nx-fhir ${PLUGIN_VERSION}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // A version written into the wrapper's installation block can break an
  // Nx 22 wrapper before any migration runs, so the generator only warns
  warnAboutNxWrapper(tree);

  // Update pluginVersion in all nx-fhir managed projects
  const projectsUpdated = updateProjectPluginVersions(tree);

  if (!projectsUpdated) {
    logger.info('All version references are already up to date.');
  }

  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('Checking for available HAPI FHIR server updates...');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Forwarded to the caller so the server outcome is printed after Nx lists
  // the changed files.
  let serverOutcome: GeneratorCallback | undefined;

  try {
    // Run the update-server generator, passing force option
    serverOutcome = await updateServerGenerator(tree, {
      force: options.force,
      fromNxMigrate: options.fromNxMigrate,
    });
  } catch (error) {
    // If no server projects found or user cancels, that's fine
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('No FHIR server projects found')) {
      logger.info(
        'No HAPI FHIR server projects found in workspace. Skipping server update check.'
      );
    } else if (message.includes('No migration path available')) {
      logger.info('Server is already at the latest supported version.');
    } else if (message.includes('does not have a hapiReleaseVersion configured')) {
      // An imported server can have no recorded release; the rest of the
      // update must still run.
      logger.info(
        'The server project has no recorded HAPI release version. Skipping server update check. ' +
          'Set hapiReleaseVersion in its project.json to enable server updates.'
      );
    } else {
      // Re-throw unexpected errors
      throw error;
    }
  }

  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('Checking for available frontend template updates...');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    await updateFrontendGenerator(tree, {
      force: options.force,
      fromNxMigrate: options.fromNxMigrate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('No FHIR frontend projects found')) {
      logger.info(
        'No FHIR frontend projects found in workspace. Skipping frontend update check.'
      );
    } else if (message.includes('No migration path available')) {
      logger.info('Frontend is already at the latest supported template version.');
    } else if (message.includes('does not have a frontendVersion configured')) {
      logger.info(
        'The frontend project has no recorded template version. Skipping frontend update check. ' +
          'Set frontendVersion in its project.json to enable frontend updates.'
      );
    } else {
      throw error;
    }
  }

  // No formatFiles here: the tree holds the merged server and frontend files,
  // which have to keep their upstream formatting for the next migration.

  logger.info('\n✅ Update complete!');

  return serverOutcome;
}

export default updateGenerator;
