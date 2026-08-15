import {
  getProjects,
  Tree,
  logger,
} from '@nx/devkit';
import { UpdateFrontendGeneratorSchema } from './schema';
import { FrontendProjectConfiguration } from '../../shared/models';
import { select, confirm } from '@inquirer/prompts';
import {
  validateFrontendMigrationPath,
  getReachableFrontendVersions,
} from '../../shared/migration/frontend-migration-resolver';
import { ensureGitRepositoryClean, getUncommittedFiles } from '../../shared/utils/git';
import { runFrontendMigration } from '../../shared/migration/frontend-migration';
import { isInteractive } from '../../shared/utils/interactive';

export async function updateFrontendGenerator(
  tree: Tree,
  options: UpdateFrontendGeneratorSchema,
) {

  // Skip git check when called from nx migrate -- the workspace will always have
  // uncommitted changes from the migrate process itself.
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

  // If project wasn't provided, prompt with a filtered list of frontend projects
  if (!options.project) {
    const projects = getProjects(tree);
    let frontendProjects = Array.from(projects.entries())
      .filter(([, config]) => config.tags?.includes('nx-fhir-frontend'))
      .map(([name]) => ({ name, value: name }));

    // Fallback: check for frontendVersion in project config
    if (frontendProjects.length === 0) {
      frontendProjects = Array.from(projects.entries())
        .filter(([, config]) => {
          const fc = config as FrontendProjectConfiguration;
          return fc.frontendVersion !== undefined;
        })
        .map(([name]) => ({ name, value: name }));
    }

    if (frontendProjects.length === 0) {
      throw new Error('No FHIR frontend projects found in the workspace');
    }

    if (!isInteractive()) {
      if (frontendProjects.length === 1) {
        options.project = frontendProjects[0].name;
        logger.info(
          `No terminal available to select a project. Using the only frontend project "${options.project}".`,
        );
      } else if (options.fromNxMigrate) {
        // Skipping keeps a non-interactive nx migrate running; there is no
        // safe automatic choice between several projects.
        logger.warn(
          `Multiple frontend projects found (${frontendProjects.map((p) => p.name).join(', ')}) and there is no terminal to ask on. ` +
            'Skipping the frontend update. Run "nx g nx-fhir:update-frontend --project=<name>" for each project.',
        );
        return;
      } else {
        throw new Error(
          'No frontend project was specified and there is no terminal to ask on. ' +
            `Pass --project with one of: ${frontendProjects.map((p) => p.name).join(', ')}`,
        );
      }
    } else {
      options.project = await select({
        message: 'Which frontend project would you like to update?',
        choices: frontendProjects,
      });

      if (!options.project) {
        throw new Error('No project selected');
      }
    }
  }

  // Get the selected project's configuration
  const projectConfig = getProjects(tree).get(
    options.project,
  ) as FrontendProjectConfiguration;
  if (!projectConfig) {
    throw new Error(`Project configuration for ${options.project} not found`);
  }

  if (!projectConfig.frontendVersion) {
    throw new Error(
      `Project ${options.project} does not have a frontendVersion configured.`,
    );
  }

  // Ensure we have a target version to update to
  if (!options.targetVersion) {
    const reachableVersions = getReachableFrontendVersions(
      projectConfig.frontendVersion,
    );

    if (reachableVersions.length === 0) {
      throw new Error(
        `No migration path available from frontend version ${projectConfig.frontendVersion}. `,
      );
    }

    const SKIP = '__skip__';
    // getReachableFrontendVersions only ever returns the current template
    // version, so the last entry is the newest version reachable.
    const latestVersion = reachableVersions[reachableVersions.length - 1];
    // Without a terminal, take the Skip choice; an unattended run must not
    // start a merge that can write conflict markers.
    const selectedVersion = isInteractive()
      ? await select({
          message: `Update ${options.project} from frontend template ${projectConfig.frontendVersion}?`,
          choices: [
            ...reachableVersions.map((v) => ({ name: v, value: v })),
            { name: 'Skip', value: SKIP },
          ],
        })
      : SKIP;

    if (!isInteractive()) {
      logger.warn(
        `No terminal available to select a target version. Skipping the frontend update. ` +
          `Run "nx g nx-fhir:update-frontend --project=${options.project} --targetVersion=${latestVersion}" to update (newest reachable: ${latestVersion}).`,
      );
    }

    if (selectedVersion === SKIP) {
      logger.info(`Skipping frontend update for ${options.project}.`);
      return;
    }

    options.targetVersion = selectedVersion;
    logger.info(
      `Will update project ${options.project} from version ${projectConfig.frontendVersion} to ${options.targetVersion}.`,
    );
  }

  // Validate migration path exists
  const validation = validateFrontendMigrationPath(
    projectConfig.frontendVersion,
    options.targetVersion,
  );

  if (!validation.valid) {
    throw new Error(
      `Cannot migrate from ${projectConfig.frontendVersion} to ${options.targetVersion}: ${validation.error}`,
    );
  }

  const migrationPath = validation.path ?? [];

  // Execute migrations in order, prompting after conflicts
  for (let i = 0; i < migrationPath.length; i++) {
    const migration = migrationPath[i];
    const isLastMigration = i === migrationPath.length - 1;

    logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`Migration step ${i + 1}/${migrationPath.length}: ${migration.from} → ${migration.to}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    const result = await runFrontendMigration(tree, {
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

      // Without a terminal the prompt can never be answered, so take the same
      // answer the prompt defaults to and pause the chain.
      const shouldContinue = isInteractive()
        ? await confirm({
            message: `Continue to the next migration (${nextMigration.from} → ${nextMigration.to})? (${remainingMigrations.length} step(s) remaining)`,
            default: false,
          })
        : false;

      if (!isInteractive()) {
        logger.warn(
          '    No terminal available to confirm. Pausing the migration chain.',
        );
      }

      if (!shouldContinue) {
        logger.info('\nMigration chain paused.');
        logger.info(`Project ${options.project} is now at version ${migration.to}.`);
        logger.info('After resolving conflicts, run the update-frontend generator again to continue.');

        return;
      }
    }
  }

  logger.info(
    `\n✅ Successfully updated ${options.project} to frontend template version ${options.targetVersion}`,
  );

  // No formatFiles here: the merged files keep the template formatting so the
  // next migration still has a clean merge base.
}

export default updateFrontendGenerator;
