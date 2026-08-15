import {
  GeneratorCallback,
  Tree,
  logger,
  readJson,
  writeJson,
  getProjects,
  updateProjectConfiguration,
} from '@nx/devkit';
import { updateServerGenerator } from '../update-server/update-server';
import { updateFrontendGenerator } from '../update-frontend/update-frontend';
import { PLUGIN_VERSION } from '../../shared/constants/versions';
import { UpdateGeneratorSchema } from './schema';

// Read Nx version from our peer dependency
const NX_VERSION = require('../../../package.json').dependencies['@nx/devkit'];

/**
 * Updates nx.json installation versions for non-JavaScript workspaces
 */
function updateNxJsonInstallation(tree: Tree): boolean {
  if (!tree.exists('nx.json')) {
    return false;
  }

  const nxJson = readJson(tree, 'nx.json');

  // Only update if using installation-based setup (non-JS workspaces)
  if (!nxJson.installation) {
    return false;
  }

  let updated = false;

  // Update the main nx version
  if (nxJson.installation.version && nxJson.installation.version !== NX_VERSION) {
    nxJson.installation.version = NX_VERSION;
    updated = true;
  }

  // Update plugin versions in installation.plugins
  if (nxJson.installation.plugins) {
    const plugins = nxJson.installation.plugins;

    // Update Nx plugins to match the Nx version
    for (const pluginName of Object.keys(plugins)) {
      if (pluginName.startsWith('@nx/') && plugins[pluginName] !== NX_VERSION) {
        plugins[pluginName] = NX_VERSION;
        updated = true;
      }
    }

    // Update nx-fhir plugin
    if (plugins['nx-fhir'] && plugins['nx-fhir'] !== PLUGIN_VERSION) {
      plugins['nx-fhir'] = PLUGIN_VERSION;
      updated = true;
    }
  }

  if (updated) {
    writeJson(tree, 'nx.json', nxJson);
    logger.info(
      `Updated nx.json installation versions to Nx ${NX_VERSION}, nx-fhir ${PLUGIN_VERSION}`
    );
  }

  return updated;
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
 * 1. Updates nx.json installation versions (for non-JS workspaces)
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

  // Update nx.json installation versions (for non-JS workspaces)
  const nxJsonUpdated = updateNxJsonInstallation(tree);

  // Update pluginVersion in all nx-fhir managed projects
  const projectsUpdated = updateProjectPluginVersions(tree);

  if (!nxJsonUpdated && !projectsUpdated) {
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
