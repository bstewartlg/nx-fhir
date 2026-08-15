import {
  logger,
  Tree,
  getProjects,
  updateProjectConfiguration,
} from '@nx/devkit';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { downloadAndExtract } from '../../generators/server/server';
import { migrateWithThreeWayMerge, logMigrationSummary, MigrationSummary } from '../utils/merge';
import { removeTesterSection } from '../utils';
import {
  integrationDockerFileNames,
  integrationOwnsServerDockerFiles,
} from '../utils/frontend-integration';
import { ServerProjectConfiguration } from '../models';
import { PLUGIN_VERSION } from '../constants/versions';

const APPLICATION_YAML = 'src/main/resources/application.yaml';

/**
 * Options for running a HAPI server migration
 */
export interface HapiMigrationOptions {
  /** The source HAPI starter release version to migrate from */
  fromVersion: string;
  /** The target HAPI starter release version to migrate to */
  toVersion: string;
  /** Optional specific project to migrate (if not provided, all matching projects are migrated) */
  project?: string;
}

/**
 * Result of a single project migration
 */
export interface ProjectMigrationResult {
  projectName: string;
  success: boolean;
  hasConflicts: boolean;
  summary: MigrationSummary;
}

/**
 * Result of the entire migration run
 */
export interface HapiMigrationResult {
  /** Whether all projects were migrated successfully */
  success: boolean;
  /** Whether any projects had merge conflicts requiring manual resolution */
  hasConflicts: boolean;
  /** Results for each project that was migrated */
  projectResults: ProjectMigrationResult[];
  /** Projects that were skipped (not found) */
  skippedProjects: string[];
}

/**
 * Finds all projects that match the source HAPI version
 */
export function findProjectsToMigrate(
  tree: Tree,
  fromVersion: string,
  specificProject?: string
): string[] {
  if (specificProject) {
    return [specificProject];
  }

  const projects = getProjects(tree);
  const projectsToUpdate: string[] = [];

  for (const [projectName, config] of projects) {
    const serverConfig = config as ServerProjectConfiguration;
    if (serverConfig.hapiReleaseVersion === fromVersion) {
      projectsToUpdate.push(projectName);
    }
  }

  return projectsToUpdate;
}

/**
 * Reports whether a project's application.yaml still declares
 * `hapi.fhir.tester`. A file that is missing or does not parse counts as
 * declaring it, which leaves the merge sides untouched.
 */
function hasTesterSection(tree: Tree, projectRoot: string): boolean {
  const content = tree.read(join(projectRoot, APPLICATION_YAML), 'utf-8');

  if (!content) {
    return true;
  }

  try {
    return parseYaml(content)?.hapi?.fhir?.tester !== undefined;
  } catch {
    return true;
  }
}

/**
 * Removes the tester section from the application.yaml of each downloaded
 * release and returns a callback that writes the original content back.
 *
 * The frontend generator removes that section from the project, so a project
 * without it merges against sides that never had it and the region stays out
 * of the merge. The release directories are shared by every project of a run,
 * so the sides are only stripped while the project that needs it is merging.
 */
function stripTesterFromReleases(releaseDirs: string[]): () => void {
  const originals: Array<[string, string]> = [];

  for (const releaseDir of releaseDirs) {
    const filePath = join(releaseDir, APPLICATION_YAML);
    if (!existsSync(filePath)) {
      continue;
    }

    const original = readFileSync(filePath, 'utf-8');
    const stripped = removeTesterSection(original);
    if (stripped === original) {
      continue;
    }

    originals.push([filePath, original]);
    writeFileSync(filePath, stripped);
  }

  return () => {
    for (const [filePath, original] of originals) {
      writeFileSync(filePath, original);
    }
  };
}

/**
 * Removes the docker files a frontend integration owns from each downloaded
 * release and returns a callback that puts them back.
 *
 * A frontend generated directly under the server root replaces the starter's
 * Dockerfile and .dockerignore with the combined frontend + server versions,
 * which the frontend template migration keeps up to date. With the files
 * absent from both release sides the server merge never visits them, so it
 * cannot conflict with files it no longer owns. The release directories are
 * shared by every project of a run, so the files are only removed while the
 * project that needs it is merging.
 */
function stripIntegrationDockerFilesFromReleases(
  tree: Tree,
  serverRoot: string,
  releaseDirs: string[]
): (() => void) | undefined {
  const projects = Array.from(getProjects(tree).values());
  if (!integrationOwnsServerDockerFiles(projects, serverRoot)) {
    return undefined;
  }

  logger.info(
    'A frontend integration owns the docker files at the server root; ' +
      'they are left to the frontend template migration.'
  );

  const originals: Array<[string, Buffer]> = [];
  for (const releaseDir of releaseDirs) {
    for (const fileName of integrationDockerFileNames()) {
      const filePath = join(releaseDir, fileName);
      if (!existsSync(filePath)) {
        continue;
      }
      originals.push([filePath, readFileSync(filePath)]);
      rmSync(filePath);
    }
  }

  return () => {
    for (const [filePath, content] of originals) {
      writeFileSync(filePath, content);
    }
  };
}

/**
 * Runs a HAPI server migration using three-way merge
 *
 * This function handles the common migration workflow:
 * 1. Find projects matching the source version
 * 2. Download old and new HAPI versions
 * 3. Perform three-way merge for each project
 * 4. Update project configuration
 * 5. If conflicts are found, prompt user to continue to next project
 * 6. Clean up temporary directories
 *
 * @returns Migration result with conflict information for chaining migrations
 *
 * @example
 * ```typescript
 * export default async function update(tree: Tree, options: UpdateServerGeneratorSchema = {}) {
 *   const result = await runHapiMigration(tree, {
 *     fromVersion: '8.4.0-2',
 *     toVersion: '8.4.0-3',
 *     project: options.project,
 *   });
 *   // result.hasConflicts indicates if manual resolution is needed
 * }
 * ```
 */
export async function runHapiMigration(
  tree: Tree,
  options: HapiMigrationOptions
): Promise<HapiMigrationResult> {
  const { fromVersion, toVersion, project } = options;

  const result: HapiMigrationResult = {
    success: true,
    hasConflicts: false,
    projectResults: [],
    skippedProjects: [],
  };

  // Find projects to update
  const projectsToUpdate = findProjectsToMigrate(tree, fromVersion, project);

  if (projectsToUpdate.length === 0) {
    logger.info(`No projects found with HAPI version ${fromVersion}.`);
    return result;
  }

  let tempDirOld: string | undefined;
  let tempDirNew: string | undefined;

  try {
    // Download both old and new versions for comparison
    logger.info(`Downloading HAPI FHIR ${fromVersion} (base version)...`);
    tempDirOld = await downloadAndExtract(fromVersion);

    logger.info(`Downloading HAPI FHIR ${toVersion} (new version)...`);
    tempDirNew = await downloadAndExtract(toVersion);

    for (const projectName of projectsToUpdate) {
      logger.info(
        `Running migration: Update project from ${fromVersion} to ${toVersion} in ${projectName}`
      );

      const projectConfig = getProjects(tree).get(
        projectName
      ) as ServerProjectConfiguration;

      if (!projectConfig) {
        logger.warn(`Project ${projectName} not found, skipping.`);
        result.skippedProjects.push(projectName);
        continue;
      }

      // Perform three-way merge
      const restoreReleases = hasTesterSection(tree, projectConfig.root)
        ? undefined
        : stripTesterFromReleases([tempDirOld, tempDirNew]);
      const restoreDockerFiles = stripIntegrationDockerFilesFromReleases(
        tree,
        projectConfig.root,
        [tempDirOld, tempDirNew]
      );

      let summary: MigrationSummary;
      try {
        summary = await migrateWithThreeWayMerge(
          tree,
          projectConfig.root,
          tempDirOld,
          tempDirNew,
          fromVersion,
          toVersion
        );
      } finally {
        restoreReleases?.();
        restoreDockerFiles?.();
      }

      const hasConflicts = summary.conflicts > 0;

      // Update project configuration
      projectConfig.hapiReleaseVersion = toVersion;
      projectConfig.pluginVersion = PLUGIN_VERSION;
      updateProjectConfiguration(tree, projectName, projectConfig);

      // Log summary
      logMigrationSummary(summary, fromVersion, toVersion);

      // Record result
      result.projectResults.push({
        projectName,
        success: true,
        hasConflicts,
        summary,
      });

      if (hasConflicts) {
        result.hasConflicts = true;
        logger.warn(
          `\n⚠️  Migration for ${projectName} completed with ${summary.conflicts} conflict(s) requiring manual resolution.`
        );
        logger.warn(
          `    Please resolve the conflicts (look for <<<<<<< markers) before running the application.`
        );
      } else {
        logger.info(`\n✅ Migration complete for ${projectName}!`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Migration failed: ${errorMessage}`);
    result.success = false;
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

  return result;
}
