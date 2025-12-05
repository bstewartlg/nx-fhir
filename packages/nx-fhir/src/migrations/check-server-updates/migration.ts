import { Tree, logger, readJson, writeJson, getProjects, updateProjectConfiguration } from '@nx/devkit';
import { updateServerGenerator } from '../../generators/update-server/update-server';
import { PLUGIN_VERSION } from '../../shared/constants/versions';

// Read Nx version from our peer dependency
const NX_VERSION = require('../../../package.json').dependencies['@nx/devkit'];

/**
 * Updates nx.json installation versions for non-JavaScript workspaces
 * that don't have a package.json
 */
function updateNxJsonInstallation(tree: Tree) {
  if (!tree.exists('nx.json')) {
    return;
  }

  const nxJson = readJson(tree, 'nx.json');
  
  // Only update if using installation-based setup (non-JS workspaces)
  if (!nxJson.installation) {
    return;
  }

  let updated = false;

  // Update the main nx version
  if (nxJson.installation.version) {
    nxJson.installation.version = NX_VERSION;
    updated = true;
  }

  // Update plugin versions in installation.plugins
  if (nxJson.installation.plugins) {
    const plugins = nxJson.installation.plugins;
    
    // Update Nx plugins to match the Nx version
    for (const pluginName of Object.keys(plugins)) {
      if (pluginName.startsWith('@nx/')) {
        plugins[pluginName] = NX_VERSION;
        updated = true;
      }
    }

    // Update nx-fhir plugin
    if (plugins['nx-fhir']) {
      plugins['nx-fhir'] = PLUGIN_VERSION;
      updated = true;
    }
  }

  if (updated) {
    writeJson(tree, 'nx.json', nxJson);
    logger.info(`Updated nx.json installation versions to Nx ${NX_VERSION}, nx-fhir ${PLUGIN_VERSION}`);
  }
}

/**
 * Updates pluginVersion in project.json for all nx-fhir managed projects
 */
function updateProjectPluginVersions(tree: Tree) {
  const projects = getProjects(tree);
  
  for (const [projectName, projectConfig] of projects) {
    // Check if this is an nx-fhir managed project (has pluginVersion property)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = projectConfig as any;
    if (config.pluginVersion && config.pluginVersion !== PLUGIN_VERSION) {
      config.pluginVersion = PLUGIN_VERSION;
      updateProjectConfiguration(tree, projectName, projectConfig);
      logger.info(`Updated pluginVersion to ${PLUGIN_VERSION} in project "${projectName}"`);
    }
  }
}

/**
 * Migration that:
 * 1. Updates nx.json installation versions for non-JS workspaces
 * 2. Updates pluginVersion in project.json for nx-fhir managed projects
 * 3. Checks for available HAPI server updates
 * 
 * This runs automatically during `nx migrate` to keep versions in sync
 * and prompt users if their server projects can be updated.
 */
export default async function update(tree: Tree) {
  // Update nx.json installation versions (for non-JS workspaces)
  updateNxJsonInstallation(tree);

  // Update pluginVersion in all nx-fhir managed projects
  updateProjectPluginVersions(tree);

  logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('Checking for available HAPI FHIR server updates...');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    // Run the update-server generator which will:
    // 1. Find server projects
    // 2. Check if updates are available
    // 3. Prompt the user to select target version
    // 4. Run the migration chain with conflict prompting
    // 
    // Pass fromNxMigrate: true to indicate this is running from nx migrate,
    // so it ignores expected uncommitted files (package.json, lock files, migrations.json)
    await updateServerGenerator(tree, { fromNxMigrate: true });
  } catch (error) {
    // If no server projects found or user cancels, that's fine
    const message = error instanceof Error ? error.message : String(error);
    
    if (message.includes('No FHIR server projects found')) {
      logger.info('No HAPI FHIR server projects found in workspace. Skipping server update check.');
    } else if (message.includes('No migration path available')) {
      logger.info('Server is already at the latest supported version.');
    } else {
      // Re-throw unexpected errors
      throw error;
    }
  }
}
