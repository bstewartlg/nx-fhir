import {
  formatFiles,
  getProjects,
  Tree,
  logger,
} from '@nx/devkit';
import * as path from 'path';
import { UpdateServerGeneratorSchema } from './schema';
import { ServerProjectConfiguration } from '../../shared/models';
import { select } from '@inquirer/prompts';
import {
  validateMigrationPath,
  getReachableVersions,
} from '../../shared/migration/hapi-migration-resolver';
import { ensureGitRepositoryClean, getUncommittedFiles } from '../../shared/utils/git';

export async function updateServerGenerator(
  tree: Tree,
  options: UpdateServerGeneratorSchema,
) {

  // Check git repository status before proceeding
  try {
    ensureGitRepositoryClean(tree.root, options.force);
  } catch (error) {
    const uncommittedFiles = getUncommittedFiles(tree.root);
    if (uncommittedFiles.length > 0) {
      logger.error('\nUncommitted files:');
      uncommittedFiles.slice(0, 10).forEach(file => logger.error(`  - ${file}`));
      if (uncommittedFiles.length > 10) {
        logger.error(`  ... and ${uncommittedFiles.length - 10} more`);
      }
    }
    throw error;
  }

  let projectConfig: ServerProjectConfiguration;

  // If project wasn't provided, prompt with a filtered list of server projects
  if (!options.project) {
    const projects = getProjects(tree);
    let serverProjects = Array.from(projects.entries())
      .filter(([_, config]) => config.tags?.includes('nx-fhir-server'))
      .map(([name]) => ({ name, value: name }));

    // No projects found with "nx-fhir-server" tag. Check for a pom.xml file in each project root instead.
    if (serverProjects.length === 0) {
      serverProjects = Array.from(projects.entries())
        .filter(([_, config]) => tree.exists(path.join(config.root, 'pom.xml')))
        .map(([name]) => ({ name, value: name }));
    }

    if (serverProjects.length === 0) {
      throw new Error('No FHIR server projects found in the workspace');
    }

    options.project = await select({
      message: 'Which server project would you like to update?',
      choices: serverProjects,
    });

    if (!options.project) {
      throw new Error('No project selected');
    }
  }

  // Get the selected project's configuration
  projectConfig = getProjects(tree).get(
    options.project,
  ) as ServerProjectConfiguration;
  if (!projectConfig) {
    throw new Error(`Project configuration for ${options.project} not found`);
  }

  // We have a project, get the current HAPI version from its configuration
  if (!projectConfig.hapiReleaseVersion) {
    throw new Error(
      `Project ${options.project} does not have a hapiReleaseVersion configured.`,
    );
  }

  // Ensure we have a target version to update to
  if (!options.targetVersion) {
    // Get all reachable versions from current version
    const reachableVersions = getReachableVersions(
      projectConfig.hapiReleaseVersion,
    );

    if (reachableVersions.length === 0) {
      throw new Error(
        `No migration path available from HAPI FHIR version ${projectConfig.hapiReleaseVersion}. `,
      );
    }

    // Prompt user to select target version
    options.targetVersion = await select({
      message: 'Which HAPI FHIR version would you like to update to?',
      choices: reachableVersions.map((v) => ({ name: v, value: v })),
    });

    logger.info(
      `Will update project ${options.project} from version ${projectConfig.hapiReleaseVersion} to ${options.targetVersion}.`,
    );
  }

  // Validate migration path exists
  const validation = validateMigrationPath(
    projectConfig.hapiReleaseVersion,
    options.targetVersion,
  );

  if (!validation.valid) {
    throw new Error(
      `Cannot migrate from ${projectConfig.hapiReleaseVersion} to ${options.targetVersion}: ${validation.error}`,
    );
  }

  // Show migration path to user
  const migrationPath = validation.path!;
  if (migrationPath.length > 1) {
    logger.info(
      `Migration will proceed through ${migrationPath.length} steps:\n` +
        migrationPath
          .map(
            (m, i) =>
              `  ${i + 1}. ${m.from} → ${m.to}${m.deprecated ? ' (deprecated)' : ''}`,
          )
          .join('\n'),
    );
  }

  // Execute migrations in order
  for (const migration of migrationPath) {
    logger.info(`\nExecuting migration: ${migration.from} → ${migration.to}`);

    try {
      // Resolve migration path from the plugin source root
      const migrationPath = path.join(
        __dirname,
        '../..',
        migration.implementation
      );
      const migrationModule = require(migrationPath);
      const migrationFn = migrationModule.default;
      await migrationFn(tree, options);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`Failed to execute migration: ${errorMessage}`);
      throw new Error(
        `Migration ${migration.from} → ${migration.to} failed: ${errorMessage}`,
      );
    }
  }

  logger.info(
    `\n✅ Successfully updated ${options.project} to HAPI FHIR ${options.targetVersion}`,
  );

  await formatFiles(tree);
}

export default updateServerGenerator;
