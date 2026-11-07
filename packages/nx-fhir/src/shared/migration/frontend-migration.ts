import {
  logger,
  Tree,
  getProjects,
  joinPathFragments,
  updateProjectConfiguration,
} from '@nx/devkit';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';
import { render as renderEjsTemplate } from 'ejs';
import { extract as extractTar } from 'tar';
import { migrateWithThreeWayMerge, logMigrationSummary, getAllFiles, MigrationSummary } from '../utils/merge';
import { FrontendProjectConfiguration, ServerProjectConfiguration } from '../models';
import { PLUGIN_VERSION } from '../constants/versions';
import { FRONTEND_TEMPLATE_CONFIG } from '../../generators/frontend/frontend';
import { ProjectMigrationResult } from './hapi-migration';
import { newTestFileSkipReason } from './new-test-files';
import {
  decideUpdate,
  planDependencyChanges,
  printDependencyChanges,
  updateFrontendDependencies,
} from './frontend-dependency-update';
import { isInteractive } from '../utils/interactive';
import {
  frontendDockerVars,
  getIntegratedServerRoot,
} from '../utils/frontend-integration';
import {
  appendDockerignoreLines,
  dockerfileMergeSides,
  frontendStageBuilds,
  isCombinedDockerfile,
  isServerRootLayout,
  removeDockerignoreLines,
  renderDockerFragments,
} from '../utils/docker-splice';

/**
 * Options for running a frontend template migration
 */
export interface FrontendMigrationOptions {
  /** The source frontend version to migrate from */
  fromVersion: string;
  /** The target frontend version to migrate to */
  toVersion: string;
  /** Optional specific project to migrate (if not provided, all matching projects are migrated) */
  project?: string;
  /** Keep the update without asking, risky dependency changes and failing checks included */
  acceptBreaking?: boolean;
}

/**
 * Result of the entire frontend migration run
 */
export interface FrontendMigrationResult {
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
 * Downloads an old nx-fhir plugin version from npm and extracts frontend template files.
 *
 * The npm tarball contains all template files at:
 *   package/src/generators/frontend/files/
 *
 * @returns Path to the directory containing extracted template files
 */
export async function downloadOldFrontendTemplates(version: string): Promise<string> {
  const tempDir = join(tmpdir(), `nx-fhir-frontend-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });

  const tarballPath = join(tempDir, `nx-fhir-${version}.tgz`);
  const url = `https://registry.npmjs.org/nx-fhir/-/nx-fhir-${version}.tgz`;

  logger.info(`Downloading nx-fhir@${version} from npm registry...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download nx-fhir@${version}: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(tarballPath, buffer);

  // Extract the tarball
  const extractDir = join(tempDir, 'extracted');
  mkdirSync(extractDir, { recursive: true });

  await extractTar({ file: tarballPath, cwd: extractDir });

  // Clean up the tarball
  rmSync(tarballPath);

  // The template files are at: extracted/package/src/generators/frontend/files/
  const filesDir = join(extractDir, 'package', 'src', 'generators', 'frontend', 'files');

  if (!existsSync(filesDir)) {
    throw new Error(
      `Template files not found in nx-fhir@${version} package. Expected at: ${filesDir}`
    );
  }

  return filesDir;
}

/**
 * Render template files from source directories into an output directory.
 *
 * Handles:
 * - `.template` files: applies `<%= var %>` substitution, strips extension
 * - `__varName__` in file/directory names: replaces with variable value
 * - All other files: copied as-is
 */
function renderTemplates(
  srcDirs: string[],
  outputDir: string,
  vars: Record<string, string | boolean>
): void {
  mkdirSync(outputDir, { recursive: true });

  for (const srcDir of srcDirs) {
    if (!existsSync(srcDir)) continue;

    const files = getAllFiles(srcDir);
    for (const relPath of files) {
      let outPath = relPath;

      // Handle __var__ substitutions in path segments
      outPath = outPath.replace(/__([^_]+)__/g, (_, varName) => String(vars[varName] ?? ''));

      // Handle .template extension
      const isTemplate = outPath.endsWith('.template');
      if (isTemplate) {
        outPath = outPath.slice(0, -'.template'.length);
      }

      const srcPath = join(srcDir, relPath);
      const destPath = join(outputDir, outPath);
      mkdirSync(dirname(destPath), { recursive: true });

      if (isTemplate) {
        const content = readFileSync(srcPath, 'utf-8');
        // ejs is the engine behind devkit's generateFiles, so the output is
        // byte identical to what the generator wrote. The ejs dependency must
        // track the version @nx/devkit pins, not the newest release. The
        // filename option resolves an include next to the template that
        // names it, as generateFiles does.
        try {
          writeFileSync(
            destPath,
            renderEjsTemplate(content, vars, { filename: srcPath })
          );
        } catch (error) {
          throw new Error(`Failed to render template ${relPath}`, {
            cause: error,
          });
        }
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }
}

/**
 * Resolve clinical template navigation variant, matching the frontend generator behavior.
 *
 * Selects the correct `__root.tsx` variant based on navigation layout,
 * then removes the `_variants/` directory and unused sidebar components for topnav.
 */
function resolveClinicalVariant(
  dir: string,
  navigationLayout: string
): void {
  const variantsDir = join(dir, '_variants');
  if (!existsSync(variantsDir)) return;

  const variantFile = navigationLayout === 'topnav'
    ? join(variantsDir, '__root-topnav.tsx')
    : join(variantsDir, '__root-sidebar.tsx');

  if (existsSync(variantFile)) {
    const rootContent = readFileSync(variantFile, 'utf-8');
    const rootDest = join(dir, 'src', 'routes', '__root.tsx');
    mkdirSync(dirname(rootDest), { recursive: true });
    writeFileSync(rootDest, rootContent);
  }

  rmSync(variantsDir, { recursive: true, force: true });

  // For topnav, remove sidebar-specific components
  if (navigationLayout === 'topnav') {
    const sidebarFiles = [
      join(dir, 'src', 'components', 'app-sidebar.tsx'),
      join(dir, 'src', 'components', 'ui', 'sidebar.tsx'),
      join(dir, 'src', 'components', 'ui', 'sheet.tsx'),
    ];
    for (const file of sidebarFiles) {
      if (existsSync(file)) {
        rmSync(file);
      }
    }
  }
}

/**
 * Determine the template source directories for a given version's extracted files.
 *
 * Handles the structural difference between:
 * - 0.2.0: single `webapp/` directory
 * - 0.2.1+: `common/` + `{template}/` directories
 */
function getTemplateSourceDirs(
  filesDir: string,
  template: string
): string[] {
  // New structure: common/ + template/
  const commonDir = join(filesDir, 'common');
  const templateDir = join(filesDir, template);
  if (existsSync(commonDir) && existsSync(templateDir)) {
    return [commonDir, templateDir];
  }

  // Legacy structure: webapp/ (used for browser-equivalent in 0.2.0)
  const webappDir = join(filesDir, 'webapp');
  if (existsSync(webappDir)) {
    return [webappDir];
  }

  throw new Error(
    `Could not find template directories in ${filesDir}. ` +
    `Expected either common/+${template}/ or webapp/.`
  );
}

/**
 * Three-way merges the frontend lines that the generator added to the HAPI
 * starter's own Dockerfile and .dockerignore. Both merge sides come from the
 * project's own files, one with the old frontend lines and one with the new.
 * The merge then changes only the frontend lines and keeps every user edit.
 * Returns null when a plugin version has no docker fragments, because the
 * merge then has no old frontend lines to use as its base. Also returns null
 * when the Dockerfile has no frontend stage. The generator adds the ignore
 * lines only together with the stage, so without the stage the merge would
 * read missing ignore lines as a user deletion. Also returns null when the
 * stage builds another frontend, because the merge would write this
 * frontend's lines into that frontend's stage.
 */
async function migrateInsertedDockerLines(
  tree: Tree,
  serverRoot: string,
  frontendRoot: string,
  oldFilesDir: string,
  newFilesDir: string,
  dockerVars: Record<string, string | boolean>,
  fromVersion: string,
  toVersion: string,
  tempDirs: string[]
): Promise<MigrationSummary | null> {
  const dockerfilePath = joinPathFragments(serverRoot, 'Dockerfile');
  const dockerignorePath = joinPathFragments(serverRoot, '.dockerignore');
  const oldFragments = renderDockerFragments(oldFilesDir, dockerVars);
  const newFragments = renderDockerFragments(newFilesDir, dockerVars);
  if (oldFragments === null || newFragments === null) {
    logger.info(
      "Template directory 'docker-fragments' is not present in both plugin versions. " +
        `The migration does not change ${dockerfilePath} or ${dockerignorePath}.`
    );
    return null;
  }

  const dockerfile = tree.read(dockerfilePath, 'utf-8') ?? '';
  const sides = dockerfileMergeSides(dockerfile, oldFragments, newFragments);
  if (sides === null) {
    logger.warn(
      `${dockerfilePath} is missing, has no build-frontend stage, or has no FROM line or no COPY src/ line. ` +
        `The migration leaves ${dockerfilePath} and ${dockerignorePath} unchanged.`
    );
    return null;
  }
  if (!frontendStageBuilds(dockerfile, frontendRoot)) {
    logger.warn(
      `${dockerfilePath} has a build-frontend stage for a frontend other than '${frontendRoot}'. ` +
        `The migration leaves ${dockerfilePath} and ${dockerignorePath} unchanged.`
    );
    return null;
  }

  const tempOld = join(tmpdir(), `nx-fhir-old-${crypto.randomUUID()}`);
  const tempNew = join(tmpdir(), `nx-fhir-new-${crypto.randomUUID()}`);
  tempDirs.push(tempOld, tempNew);
  mkdirSync(tempOld, { recursive: true });
  mkdirSync(tempNew, { recursive: true });
  writeFileSync(join(tempOld, 'Dockerfile'), sides.base);
  writeFileSync(join(tempNew, 'Dockerfile'), sides.next);

  const dockerignore = tree.read(dockerignorePath, 'utf-8');
  if (dockerignore !== null) {
    const withoutFrontend = removeDockerignoreLines(
      dockerignore,
      oldFragments.dockerignoreLines
    );
    writeFileSync(
      join(tempOld, '.dockerignore'),
      appendDockerignoreLines(withoutFrontend, oldFragments.dockerignoreLines)
    );
    writeFileSync(
      join(tempNew, '.dockerignore'),
      appendDockerignoreLines(withoutFrontend, newFragments.dockerignoreLines)
    );
  }

  return migrateWithThreeWayMerge(
    tree,
    serverRoot,
    tempOld,
    tempNew,
    fromVersion,
    toVersion
  );
}

/**
 * Three-way merges the server-integration files the frontend generator wrote
 * outside the frontend project root: the multi-stage Dockerfile and
 * .dockerignore next to the frontend project, and the SPA/CORS Java classes
 * inside the server source tree. For a frontend directly beneath a server at
 * the workspace root, the merge covers only the frontend lines in the
 * starter's own Dockerfile and .dockerignore, unless the Dockerfile there is
 * a combined one. Runs only for projects integrated with a server. A
 * template directory the old plugin version does not ship is
 * skipped: without an old side to merge against, every file would count as
 * newly added and overwrite the user's copy.
 */
async function migrateIntegrationTemplates(
  tree: Tree,
  projectConfig: FrontendProjectConfiguration,
  oldFilesDir: string,
  newFilesDir: string,
  fromVersion: string,
  toVersion: string,
  tempDirs: string[]
): Promise<MigrationSummary[]> {
  const serverRoot = getIntegratedServerRoot(projectConfig);
  if (!serverRoot) {
    return [];
  }

  // The same variables the frontend generator rendered with, re-derived from
  // the current workspace. An unchanged working copy then matches the old
  // render byte for byte and merges cleanly.
  const dockerVars = await frontendDockerVars(
    tree,
    projectConfig.root,
    serverRoot
  );

  const serverDockerfile = tree.read(
    joinPathFragments(serverRoot, 'Dockerfile'),
    'utf-8'
  );
  const insertsDockerLines =
    isServerRootLayout(serverRoot, projectConfig.root) &&
    !isCombinedDockerfile(serverDockerfile ?? '');

  const mergeTargets: Array<{
    templateDir: string;
    vars: Record<string, string | boolean>;
    outputRoot: string;
  }> = insertsDockerLines
    ? []
    : [
        {
          templateDir: 'docker',
          vars: dockerVars,
          outputRoot: join(projectConfig.root, '..'),
        },
      ];

  const serverProject = Array.from(getProjects(tree).values()).find(
    (project) => project.root === serverRoot
  ) as ServerProjectConfiguration | undefined;
  if (serverProject?.packageBase) {
    mergeTargets.push({
      templateDir: 'server',
      vars: { packageBase: serverProject.packageBase },
      outputRoot: join(
        serverRoot,
        'src/main/java',
        serverProject.packageBase.replace(/\./g, '/')
      ),
    });
  } else {
    logger.warn(
      `Could not find a server project at '${serverRoot}' with a packageBase; ` +
        'skipping migration of the integration Java files.'
    );
  }

  const summaries: MigrationSummary[] = [];
  if (insertsDockerLines) {
    const summary = await migrateInsertedDockerLines(
      tree,
      serverRoot,
      projectConfig.root,
      oldFilesDir,
      newFilesDir,
      dockerVars,
      fromVersion,
      toVersion,
      tempDirs
    );
    if (summary !== null) {
      summaries.push(summary);
    }
  }
  for (const { templateDir, vars, outputRoot } of mergeTargets) {
    const oldDir = join(oldFilesDir, templateDir);
    const newDir = join(newFilesDir, templateDir);
    if (!existsSync(oldDir) || !existsSync(newDir)) {
      logger.info(
        `Template directory '${templateDir}' is not present in both plugin versions; skipping.`
      );
      continue;
    }

    const tempOld = join(tmpdir(), `nx-fhir-old-${crypto.randomUUID()}`);
    const tempNew = join(tmpdir(), `nx-fhir-new-${crypto.randomUUID()}`);
    tempDirs.push(tempOld, tempNew);
    renderTemplates([oldDir], tempOld, vars);
    renderTemplates([newDir], tempNew, vars);

    const summary = await migrateWithThreeWayMerge(
      tree,
      outputRoot,
      tempOld,
      tempNew,
      fromVersion,
      toVersion
    );
    // Conflict reports print these paths, so make them workspace relative
    // instead of relative to the merge root.
    for (const result of summary.results) {
      result.path = join(outputRoot, result.path);
    }
    summaries.push(summary);
  }
  return summaries;
}

/**
 * Finds all frontend projects that match the source frontend version
 */
export function findFrontendProjectsToMigrate(
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
    const frontendConfig = config as FrontendProjectConfiguration;
    if (frontendConfig.frontendVersion === fromVersion) {
      projectsToUpdate.push(projectName);
    }
  }

  return projectsToUpdate;
}

/**
 * Runs a frontend template migration using three-way merge.
 *
 * 1. Find projects matching the source version
 * 2. Download old plugin templates from npm
 * 3. Render old and new templates into temp directories
 * 4. Perform three-way merge for each project
 * 5. Update project configuration
 * 6. Clean up temporary directories
 */
export async function runFrontendMigration(
  tree: Tree,
  options: FrontendMigrationOptions
): Promise<FrontendMigrationResult> {
  const { fromVersion, toVersion, project, acceptBreaking = false } = options;

  const result: FrontendMigrationResult = {
    success: true,
    hasConflicts: false,
    projectResults: [],
    skippedProjects: [],
  };

  const projectsToUpdate = findFrontendProjectsToMigrate(tree, fromVersion, project);

  if (projectsToUpdate.length === 0) {
    logger.info(`No projects found with frontend version ${fromVersion}.`);
    return result;
  }

  let downloadTempDir: string | undefined;
  const tempDirs: string[] = [];

  try {
    // Download old plugin templates from npm
    const oldFilesDir = await downloadOldFrontendTemplates(fromVersion);
    // Track the top-level download temp dir for cleanup
    // oldFilesDir = .../nx-fhir-frontend-UUID/extracted/package/src/generators/frontend/files
    downloadTempDir = oldFilesDir.split('extracted')[0];

    // Get the new templates from the current installed plugin
    const newFilesDir = join(__dirname, '../../generators/frontend/files');

    for (const projectName of projectsToUpdate) {
      logger.info(
        `Running migration: Update frontend from ${fromVersion} to ${toVersion} in ${projectName}`
      );

      const projectConfig = getProjects(tree).get(
        projectName
      ) as FrontendProjectConfiguration;

      if (!projectConfig) {
        logger.warn(`Project ${projectName} not found, skipping.`);
        result.skippedProjects.push(projectName);
        continue;
      }

      // Determine template type (default to browser for legacy projects)
      const template = projectConfig.frontendTemplate ?? 'browser';
      const navigationLayout = projectConfig.navigationLayout ?? 'sidebar';

      // Classified before the merge, so an unattended run with a risky
      // change can stop while the tree is still untouched
      const hasPackageJson = tree.exists(`${projectConfig.root}/package.json`);
      const dependencyChanges = hasPackageJson
        ? planDependencyChanges(tree, projectConfig.root, template)
        : [];
      const riskyCount = dependencyChanges.filter(
        (change) => change.kind === 'risky'
      ).length;
      const unattended = decideUpdate({
        riskyCount,
        newFailureCount: 0,
        hasConflicts: false,
        acceptBreaking,
        interactive: isInteractive(),
      });
      if (unattended.decision === 'undo') {
        printDependencyChanges(projectName, dependencyChanges);
        logger.info(
          `\nSkipping the frontend update for ${projectName}: ${riskyCount} risky dependency change(s) and no terminal to ask on. ` +
            `Run "nx g nx-fhir:update-frontend --project=${projectName} --targetVersion=${toVersion} --acceptBreaking" to apply it.`
        );
        result.projectResults.push({
          projectName,
          success: true,
          hasConflicts: false,
          skipped: true,
        });
        continue;
      }

      // Render old templates into a temp directory
      const tempOld = join(tmpdir(), `nx-fhir-old-${crypto.randomUUID()}`);
      tempDirs.push(tempOld);

      const oldSrcDirs = getTemplateSourceDirs(oldFilesDir, template);
      // Both sides render with the same variables so substituted values never
      // read as user edits. A template that predates a variable simply has no
      // placeholder for it.
      const oldVars: Record<string, string> = {
        name: projectName,
        dot: '.',
        ...(FRONTEND_TEMPLATE_CONFIG[template] ?? {}),
      };
      renderTemplates(oldSrcDirs, tempOld, oldVars);

      if (template === 'clinical') {
        resolveClinicalVariant(tempOld, navigationLayout);
      }

      // Render new templates into a temp directory
      const tempNew = join(tmpdir(), `nx-fhir-new-${crypto.randomUUID()}`);
      tempDirs.push(tempNew);

      const newSrcDirs = getTemplateSourceDirs(newFilesDir, template);
      const newVars: Record<string, string> = {
        name: projectName,
        dot: '.',
        ...(FRONTEND_TEMPLATE_CONFIG[template] ?? {}),
      };
      renderTemplates(newSrcDirs, tempNew, newVars);

      if (template === 'clinical') {
        resolveClinicalVariant(tempNew, navigationLayout);
      }

      // The merge writes subjects before it reaches their new tests, so the
      // test decisions are taken on the project as it is before the merge.
      const testContext = {
        tree,
        projectRoot: projectConfig.root,
        oldDir: tempOld,
        newDir: tempNew,
      };
      const testSkipReasons = new Map(
        getAllFiles(tempNew).map((p) => [
          p,
          newTestFileSkipReason(p, testContext),
        ])
      );

      // Perform three-way merge
      const summary = await migrateWithThreeWayMerge(
        tree,
        projectConfig.root,
        tempOld,
        tempNew,
        fromVersion,
        toVersion,
        { skipNewFile: (p) => testSkipReasons.get(p) }
      );

      // Merge the server-integration files (Dockerfile, .dockerignore, SPA
      // Java classes) that live outside the frontend project root.
      const integrationSummaries = await migrateIntegrationTemplates(
        tree,
        projectConfig,
        oldFilesDir,
        newFilesDir,
        fromVersion,
        toVersion,
        tempDirs
      );
      for (const integrationSummary of integrationSummaries) {
        summary.added += integrationSummary.added;
        summary.removed += integrationSummary.removed;
        summary.merged += integrationSummary.merged;
        summary.conflicts += integrationSummary.conflicts;
        summary.unchanged += integrationSummary.unchanged;
        summary.results.push(...integrationSummary.results);
      }

      const hasConflicts = summary.conflicts > 0;

      // Update project configuration
      projectConfig.frontendVersion = toVersion;
      projectConfig.pluginVersion = PLUGIN_VERSION;
      updateProjectConfiguration(tree, projectName, projectConfig);

      // The conflict list and the skipped test files print before the
      // dependency update asks whether to keep the update
      logMigrationSummary(summary, fromVersion, toVersion);

      if (hasPackageJson) {
        const outcome = await updateFrontendDependencies({
          tree,
          projectName,
          projectRoot: projectConfig.root,
          changes: dependencyChanges,
          hasConflicts,
          acceptBreaking,
        });
        // The undo emptied the whole tree, so no further project can build on it
        if (outcome === 'undone') {
          result.projectResults.push({
            projectName,
            success: true,
            hasConflicts: false,
            skipped: true,
          });
          break;
        }
      }

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
    if (downloadTempDir && existsSync(downloadTempDir)) {
      logger.info(`Cleaning up temporary directory ${downloadTempDir}`);
      rmSync(downloadTempDir, { recursive: true, force: true });
    }
    for (const dir of tempDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  return result;
}
