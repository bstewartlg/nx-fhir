import {
  formatFiles,
  getProjects,
  Tree,
  logger,
} from '@nx/devkit';
import * as path from 'path';
import { UpdateServerGeneratorSchema } from './schema';
import { ServerProjectConfiguration } from '../../shared/models';
import { select, confirm } from '@inquirer/prompts';
import {
  validateMigrationPath,
  getReachableVersions,
} from '../../shared/migration/hapi-migration-resolver';
import { ensureGitRepositoryClean, getUncommittedFiles } from '../../shared/utils/git';
import { runHapiMigration } from '../../shared/migration/hapi-migration';

export async function updateServerGenerator(
  tree: Tree,
  options: UpdateServerGeneratorSchema,
) {

  // Skip git check when called from nx migrate -- the workspace will always have
  // uncommitted changes (package.json, lockfiles, migrations.json, nx.json, project.json)
  // from the migrate process itself. The user can review and revert via git diff.
  if (!options.fromNxMigrate) {
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
  }

  // If project wasn't provided, prompt with a filtered list of server projects
  if (!options.project) {
    const projects = getProjects(tree);
    let serverProjects = Array.from(projects.entries())
      .filter(([, config]) => config.tags?.includes('nx-fhir-server'))
      .map(([name]) => ({ name, value: name }));

    // No projects found with "nx-fhir-server" tag. Check for a pom.xml file in each project root instead.
    if (serverProjects.length === 0) {
      serverProjects = Array.from(projects.entries())
        .filter(([, config]) => tree.exists(path.join(config.root, 'pom.xml')))
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
  const projectConfig = getProjects(tree).get(
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

    // Prompt user to select target version (with option to skip)
    const SKIP = '__skip__';
    const selectedVersion = await select({
      message: `Update ${options.project} from HAPI FHIR ${projectConfig.hapiReleaseVersion}?`,
      choices: [
        ...reachableVersions.map((v) => ({ name: v, value: v })),
        { name: 'Skip', value: SKIP },
      ],
    });

    if (selectedVersion === SKIP) {
      logger.info(`Skipping server update for ${options.project}.`);
      return;
    }

    options.targetVersion = selectedVersion;
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
  const migrationPath = validation.path ?? [];
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

  // Execute migrations in order, prompting after conflicts
  for (let i = 0; i < migrationPath.length; i++) {
    const migration = migrationPath[i];
    const isLastMigration = i === migrationPath.length - 1;

    logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`Migration step ${i + 1}/${migrationPath.length}: ${migration.from} → ${migration.to}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    const result = await runHapiMigration(tree, {
      fromVersion: migration.from,
      toVersion: migration.to,
      project: options.project,
    });

    if (!result.success) {
      throw new Error(`Migration ${migration.from} → ${migration.to} failed`);
    }

    // If there were conflicts and more migrations remain, prompt user
    if (result.hasConflicts && !isLastMigration) {
      const remainingMigrations = migrationPath.slice(i + 1);
      const nextMigration = remainingMigrations[0];

      logger.warn(`\n⚠️  Merge conflicts were found in this migration step.`);
      logger.warn(`    It's recommended to resolve conflicts before continuing.`);
      logger.warn(`    Look for <<<<<<< markers in your files.`);

      const shouldContinue = await confirm({
        message: `Continue to the next migration (${nextMigration.from} → ${nextMigration.to})? (${remainingMigrations.length} step(s) remaining)`,
        default: false,
      });

      if (!shouldContinue) {
        logger.info('\nMigration chain paused.');
        logger.info(`Project ${options.project} is now at version ${migration.to}.`);
        logger.info('After resolving conflicts, run the update-server generator again to continue.');
        
        // Still format files and exit successfully - partial migration is valid
        await formatFiles(tree);
        return;
      }
    }
  }

  logger.info(
    `\n✅ Successfully updated ${options.project} to HAPI FHIR ${options.targetVersion}`,
  );

  await formatFiles(tree);
}

export default updateServerGenerator;
