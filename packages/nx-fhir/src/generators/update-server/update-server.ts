import {
  GeneratorCallback,
  getProjects,
  Tree,
  logger,
  visitNotIgnoredFiles,
} from '@nx/devkit';
import { UpdateServerGeneratorSchema } from './schema';
import { ServerProjectConfiguration } from '../../shared/models';
import { select } from '@inquirer/prompts';
import {
  validateMigrationPath,
  getReachableVersions,
} from '../../shared/migration/hapi-migration-resolver';
import { ensureGitRepositoryClean, getUncommittedFiles } from '../../shared/utils/git';
import {
  HapiMigrationResult,
  runHapiMigration,
} from '../../shared/migration/hapi-migration';
import { HapiMigration } from '../../shared/migration/hapi-migration-resolver';
import { isInteractive } from '../../shared/utils/interactive';
import { getServerProjects } from '../../shared/utils';
import {
  isHapiVersionSupported,
  SUPPORTED_HAPI_VERSIONS,
} from '../../shared/constants/versions';
import {
  fetchStarterImageVersions,
  matchImageVersion,
} from '../../shared/utils/hapi-release-discovery';

/**
 * Updates a server project to a newer HAPI release.
 *
 * The returned callback repeats the outcome of the run. Nx prints the tree
 * change listing before it invokes the callback, so on a long migration the
 * outcome is the last thing on screen instead of scrolling away above the
 * listing. A run that migrates nothing returns nothing.
 */
export async function updateServerGenerator(
  tree: Tree,
  options: UpdateServerGeneratorSchema,
): Promise<GeneratorCallback | undefined> {

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

  // If project wasn't provided, prompt with a filtered list of server projects.
  // The shared fingerprint (fhirVersion plus pom.xml) keeps plain Maven
  // applications out of the list; a bare pom.xml is not a FHIR server.
  if (!options.project) {
    const serverProjects = (await getServerProjects(tree)).map((name) => ({
      name,
      value: name,
    }));

    if (serverProjects.length === 0) {
      throw new Error('No FHIR server projects found in the workspace');
    }

    if (!isInteractive()) {
      if (serverProjects.length === 1) {
        options.project = serverProjects[0].name;
        logger.info(
          `No terminal available to select a project. Using the only server project "${options.project}".`,
        );
      } else if (options.fromNxMigrate) {
        // Skipping keeps a non-interactive nx migrate running; there is no
        // safe automatic choice between several projects.
        logger.warn(
          `Multiple server projects found (${serverProjects.map((p) => p.name).join(', ')}) and there is no terminal to ask on. ` +
            'Skipping the server update. Run "nx g nx-fhir:update-server --project=<name>" for each project.',
        );
        return;
      } else {
        throw new Error(
          'No server project was specified and there is no terminal to ask on. ' +
            `Pass --project with one of: ${serverProjects.map((p) => p.name).join(', ')}`,
        );
      }
    } else {
      options.project = await select({
        message: 'Which server project would you like to update?',
        choices: serverProjects,
      });

      if (!options.project) {
        throw new Error('No project selected');
      }
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

  const sourceVersion = await resolveRecordedRelease(
    projectConfig.hapiReleaseVersion,
    options.project,
  );
  if (!sourceVersion) {
    return;
  }

  // Ensure we have a target version to update to
  if (!options.targetVersion) {
    // Get all reachable versions from current version
    const reachableVersions = getReachableVersions(sourceVersion);

    if (reachableVersions.length === 0) {
      throw new Error(
        `No migration path available from HAPI FHIR version ${sourceVersion}. `,
      );
    }

    // Prompt user to select target version (with option to skip)
    const SKIP = '__skip__';
    // getReachableVersions returns versions ordered oldest to newest, so the
    // last entry is the newest version reachable from the current one.
    const latestVersion = reachableVersions[reachableVersions.length - 1];
    // Without a terminal, take the Skip choice; an unattended run must not
    // start a merge that can write conflict markers.
    const selectedVersion = isInteractive()
      ? await select({
          message: `Update ${options.project} (currently HAPI FHIR ${sourceVersion}) to which release?`,
          choices: [
            ...[...reachableVersions].reverse().map((v) => ({ name: v, value: v })),
            { name: 'Skip', value: SKIP },
          ],
        })
      : SKIP;

    if (!isInteractive()) {
      logger.warn(
        `No terminal available to select a target version. Skipping the server update. ` +
          `Run "nx g nx-fhir:update-server --project=${options.project} --targetVersion=${latestVersion}" to update (newest reachable: ${latestVersion}).`,
      );
    }

    if (selectedVersion === SKIP) {
      logger.info(`Skipping server update for ${options.project}.`);
      return;
    }

    options.targetVersion = selectedVersion;
    logger.info(
      `Will update project ${options.project} from version ${sourceVersion} to ${options.targetVersion}.`,
    );
  }

  // Validate migration path exists
  const validation = validateMigrationPath(sourceVersion, options.targetVersion);

  if (!validation.valid) {
    throw new Error(
      `Cannot migrate from ${sourceVersion} to ${options.targetVersion}: ${validation.error}`,
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
              `  ${i + 1}. ${m.from} → ${m.to}${m.bridge ? ' (untested bridge)' : ''}${m.deprecated ? ' (deprecated)' : ''}`,
          )
          .join('\n'),
    );
  }

  // A merge over unresolved markers buries them inside the next set of
  // markers, which no longer describes any version of the file.
  const conflictedFiles = findFilesWithConflictMarkers(tree, projectConfig.root);
  if (conflictedFiles.length > 0) {
    logger.error('\nFiles with unresolved conflict markers:');
    conflictedFiles.slice(0, 10).forEach((file) => logger.error(`  - ${file}`));
    if (conflictedFiles.length > 10) {
      logger.error(`  ... and ${conflictedFiles.length - 10} more`);
    }
    throw new Error(
      `Project ${options.project} still has unresolved merge conflict markers. ` +
        'Resolve them before running the server update.',
    );
  }

  // Execute migrations in order, pausing after conflicts
  for (let i = 0; i < migrationPath.length; i++) {
    const migration = migrationPath[i];
    const isLastMigration = i === migrationPath.length - 1;

    logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`Migration step ${i + 1}/${migrationPath.length}: ${migration.from} → ${migration.to}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    if (migration.bridge) {
      logger.warn(
        `⚠️  ${migration.from} is outside the tested migration set. ` +
          `This step merges directly to ${migration.to} on a best-effort basis and may produce more conflicts than a tested step.`,
      );
    }

    const result = await runMigrationStep(tree, migration, options.project);

    if (!result.success) {
      throw new Error(`Migration ${migration.from} → ${migration.to} failed`);
    }

    // A further step would merge over the markers this step wrote, which the
    // pre-run check rejects, so the chain always stops here.
    if (result.hasConflicts && !isLastMigration) {
      const remainingMigrations = migrationPath.length - (i + 1);

      logger.warn(`\n⚠️  Merge conflicts were found in this migration step.`);
      logger.warn(`    Look for <<<<<<< markers in your files.`);
      logger.info('\nMigration chain paused.');
      logger.info(`Project ${options.project} is now at version ${migration.to}.`);
      logger.info(
        `After resolving the conflicts, run the update-server generator again to continue (${remainingMigrations} step(s) remaining).`,
      );

      // Exit successfully - a partial migration is valid
      const conflictedFilesAtPause = findFilesWithConflictMarkers(
        tree,
        projectConfig.root,
      );
      return () => {
        logger.warn(
          `\n⚠️  Migration chain paused: ${options.project} is at HAPI FHIR ${migration.to} with unresolved conflicts.`,
        );
        warnConflictedFiles(conflictedFilesAtPause);
        logger.warn(
          `    Resolve the conflicts, then run the update-server generator again to continue (${remainingMigrations} step(s) remaining).`,
        );
      };
    }
  }

  // The last step can leave markers too. Reporting plain success then would
  // send the user off with a project that does not build.
  const conflictedFilesAtEnd = findFilesWithConflictMarkers(
    tree,
    projectConfig.root,
  );

  // No formatFiles here: the merged files keep the upstream formatting so the
  // next migration still has a clean merge base.

  if (conflictedFilesAtEnd.length > 0) {
    logger.warn(
      `\n⚠️  Updated ${options.project} to HAPI FHIR ${options.targetVersion}, but conflicts need manual resolution.`,
    );
    logger.warn(`    Look for <<<<<<< markers in your files.`);

    return () => {
      logger.warn(
        `\n⚠️  ${options.project} is at HAPI FHIR ${options.targetVersion} with unresolved conflicts.`,
      );
      warnConflictedFiles(conflictedFilesAtEnd);
      logger.warn(
        '    Resolve the conflict markers before building the project.',
      );
    };
  }

  logger.info(
    `\n✅ Successfully updated ${options.project} to HAPI FHIR ${options.targetVersion}`,
  );

  return () =>
    logger.info(
      `\n✅ ${options.project} updated to HAPI FHIR ${options.targetVersion}.`,
    );
}

/** Lists conflicted files the way the pre-run guard does, as warnings. */
function warnConflictedFiles(files: string[]): void {
  files.slice(0, 10).forEach((file) => logger.warn(`  - ${file}`));
  if (files.length > 10) {
    logger.warn(`  ... and ${files.length - 10} more`);
  }
}

export default updateServerGenerator;

/** The marker threeWayMerge writes at the start of every conflict it records. */
const CONFLICT_MARKER = /^<<<<<<< CURRENT \(Your changes\)/m;

/**
 * Returns the files under a project that still hold merge conflict markers
 * from an earlier migration.
 */
function findFilesWithConflictMarkers(tree: Tree, projectRoot: string): string[] {
  const conflicted: string[] = [];

  visitNotIgnoredFiles(tree, projectRoot, (filePath) => {
    const content = tree.read(filePath, 'utf-8');
    if (content && CONFLICT_MARKER.test(content)) {
      conflicted.push(filePath);
    }
  });

  return conflicted;
}

/**
 * Runs one step of a migration path. A step naming an implementation module
 * runs that module; every other step runs the generic three-way merge.
 */
export async function runMigrationStep(
  tree: Tree,
  migration: HapiMigration,
  project: string | undefined,
): Promise<HapiMigrationResult> {
  if (!migration.implementation) {
    return runHapiMigration(tree, {
      fromVersion: migration.from,
      toVersion: migration.to,
      project,
    });
  }

  const loaded = await import(`../../${migration.implementation}`);
  const run = loaded.default ?? loaded;
  // A custom module that reports nothing is taken as a clean run.
  return (
    (await run(tree, { project })) ?? {
      success: true,
      hasConflicts: false,
      projectResults: [],
      skippedProjects: [],
    }
  );
}

/**
 * Resolves the release a project records into one this plugin can migrate
 * from. Returns undefined when the release stays unknown, which skips the
 * project rather than starting a migration that cannot download its base.
 */
async function resolveRecordedRelease(
  recorded: string,
  project: string | undefined,
): Promise<string | undefined> {
  if (isHapiVersionSupported(recorded)) {
    return recorded;
  }

  const catalog = await fetchStarterImageVersions();
  if (catalog?.includes(recorded)) {
    return recorded;
  }

  const matched = catalog ? matchImageVersion(catalog, recorded) : undefined;
  if (matched) {
    logger.info(
      `Recorded release ${recorded} matches the published release ${matched}. Migrating from ${matched}.`,
    );
    return matched;
  }

  const base = recorded.split('-')[0];
  const family = (catalog ?? []).filter(
    (version) => version === base || version.startsWith(`${base}-`),
  );

  if (!isInteractive()) {
    logger.warn(
      `The recorded release ${recorded} does not correspond to a published starter release. ` +
        `Skipping the server update for ${project ?? 'the project'}. ` +
        `Set hapiReleaseVersion in its project.json to the release the server is on` +
        (family.length > 0 ? ` (published for ${base}: ${family.join(', ')})` : '') +
        `, or pass --release with that value.`,
    );
    return undefined;
  }

  const SKIP = '__skip__';
  const choices = [
    ...family.map((version) => ({
      name: `${version} (published for ${base})`,
      value: version,
    })),
    ...SUPPORTED_HAPI_VERSIONS.filter((v) => !family.includes(v)).map((v) => ({
      name: v,
      value: v,
    })),
    { name: 'Skip', value: SKIP },
  ];
  const answer = await select({
    message: `The recorded release ${recorded} does not correspond to a published starter release. Which release is this server actually on?`,
    choices,
  });

  if (answer === SKIP) {
    logger.info(`Skipping server update for ${project ?? 'the project'}.`);
    return undefined;
  }
  return answer;
}
