import {
  detectPackageManager,
  logger,
  Tree,
  getProjects,
  readJson,
  updateProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import { existsSync, rmSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { isDryRun } from '../utils/dry-run';
import crypto from 'crypto';
import { render as renderEjsTemplate } from 'ejs';
import { extract as extractTar } from 'tar';
import { migrateWithThreeWayMerge, logMigrationSummary, getAllFiles, MigrationSummary } from '../utils/merge';
import { FrontendProjectConfiguration, ServerProjectConfiguration } from '../models';
import { PLUGIN_VERSION } from '../constants/versions';
import { FRONTEND_TEMPLATE_CONFIG, getFrontendDependencies } from '../../generators/frontend/frontend';
import {
  getCiInstallCommand,
  getDockerBaseImage,
  getInstallCommand,
  getLockfileName,
  getRunCommand,
} from '../utils/package-manager';
import { ProjectMigrationResult } from './hapi-migration';
import { getIntegratedServerRoot } from '../utils/frontend-integration';

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
  vars: Record<string, string>
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
        // track the version @nx/devkit pins, not the newest release.
        try {
          writeFileSync(destPath, renderEjsTemplate(content, vars));
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
 * Three-way merges the server-integration files the frontend generator wrote
 * outside the frontend project root: the multi-stage Dockerfile and
 * .dockerignore next to the frontend project, and the SPA/CORS Java classes
 * inside the server source tree. Runs only for projects integrated with a
 * server. A template directory the old plugin version does not ship is
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

  const packageManager = detectPackageManager();
  // The same variables the frontend generator rendered with, re-derived from
  // the current workspace. An unchanged working copy then matches the old
  // render byte for byte and merges cleanly.
  const dockerVars: Record<string, string> = {
    dot: '.',
    frontendRoot: projectConfig.root,
    serverRoot,
    dockerBaseImage: getDockerBaseImage(packageManager),
    lockfileName: getLockfileName(packageManager),
    ciInstallCommand: getCiInstallCommand(packageManager),
    buildCommand: getRunCommand(packageManager, 'build'),
  };

  const mergeTargets: Array<{
    templateDir: string;
    vars: Record<string, string>;
    outputRoot: string;
  }> = [
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
 * Matches a project root against one npm workspaces entry. Entries are either
 * literal paths or globs where * spans one path segment and ** spans any
 * number of segments; that subset covers the patterns npm documents.
 */
function matchesWorkspacePattern(pattern: string, projectRoot: string): boolean {
  // A globstar segment spans zero or more whole segments, so apps/**/frontend
  // also matches apps/frontend.
  const segments = pattern.split('/');
  let regex = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    if (segment === '**') {
      regex += isLast ? '.*' : '(?:[^/]+/)*';
    } else {
      const segmentRegex = segment
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*');
      regex += segmentRegex + (isLast ? '' : '/');
    }
  }
  return new RegExp(`^${regex}$`).test(projectRoot);
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
  const { fromVersion, toVersion, project } = options;

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

      // Render old templates into a temp directory
      const tempOld = join(tmpdir(), `nx-fhir-old-${crypto.randomUUID()}`);
      tempDirs.push(tempOld);

      const oldSrcDirs = getTemplateSourceDirs(oldFilesDir, template);
      // Both sides render with the same variables so substituted values never
      // read as user edits. A template that predates a variable simply has no
      // placeholder for it.
      const oldVars: Record<string, string> = {
        name: projectName,
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
        ...(FRONTEND_TEMPLATE_CONFIG[template] ?? {}),
      };
      renderTemplates(newSrcDirs, tempNew, newVars);

      if (template === 'clinical') {
        resolveClinicalVariant(tempNew, navigationLayout);
      }

      // Perform three-way merge
      const summary = await migrateWithThreeWayMerge(
        tree,
        projectConfig.root,
        tempOld,
        tempNew,
        fromVersion,
        toVersion
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

      // Sync package.json dependencies with current template
      const projectPackageJsonPath = `${projectConfig.root}/package.json`;
      if (tree.exists(projectPackageJsonPath)) {
        const packageJson = readJson(tree, projectPackageJsonPath);
        const templateDeps = getFrontendDependencies(template);

        packageJson.dependencies = { ...packageJson.dependencies, ...templateDeps.dependencies };
        packageJson.devDependencies = { ...packageJson.devDependencies, ...templateDeps.devDependencies };

        writeJson(tree, projectPackageJsonPath, packageJson);

        // Dependency installation touches the filesystem outside the tree, so a
        // preview run stops after the tree changes.
        if (!isDryRun()) {
          const absolutePackageJsonPath = join(tree.root, projectPackageJsonPath);
          const packageManager = detectPackageManager();
          const projectAbsPath = join(tree.root, projectConfig.root);
          // The lockfile and the project module tree are moved aside so the
          // install resolves fresh against the migrated package.json; an incremental
          // install can keep transitive peers pinned to versions that conflict
          // with it. The stale pins live wherever this frontend installs from:
          // the workspace root when the project is a registered npm workspace,
          // the project directory otherwise. A standalone frontend (generated
          // before workspace registration existed) must not cost the root its
          // lockfile, because the install from the project never recreates it.
          // The root node_modules stays either way: this process runs from it,
          // and the lockfile-free install reconciles it. The lockfiles are
          // moved aside rather than deleted, so a failed install puts them
          // back and the workspace still resolves from its previous state.
          const rootWorkspaces = tree.exists('package.json')
            ? (readJson(tree, 'package.json').workspaces ?? [])
            : [];
          const isWorkspaceMember =
            Array.isArray(rootWorkspaces) &&
            rootWorkspaces.some((pattern) =>
              matchesWorkspacePattern(pattern, projectConfig.root)
            );
          const lockfileDirs = isWorkspaceMember
            ? [tree.root, projectAbsPath]
            : [projectAbsPath];
          const lockfileCandidates: Array<{ original: string; backup: string }> =
            [];
          for (const dir of lockfileDirs) {
            for (const lockfile of [
              'bun.lock',
              'bun.lockb',
              'package-lock.json',
            ]) {
              const original = join(dir, lockfile);
              lockfileCandidates.push({
                original,
                backup: `${original}.nx-fhir-backup`,
              });
            }
          }
          const nodeModulesPath = join(projectAbsPath, 'node_modules');
          const nodeModulesBackup = `${nodeModulesPath}.nx-fhir-backup`;

          // A file next to its backup cannot be told apart from an install
          // interrupted midway; neither side is safe to delete. Stop before
          // touching anything.
          for (const { original, backup } of [
            ...lockfileCandidates,
            { original: nodeModulesPath, backup: nodeModulesBackup },
          ]) {
            if (existsSync(original) && existsSync(backup)) {
              throw new Error(
                `Found both ${original} and its backup ${backup}, likely left by an interrupted migration. ` +
                  'Verify which is current, remove the backup, and run the migration again.'
              );
            }
          }

          // Write package.json to disk immediately so we can run the install now.
          // The tree flush will later write the same content (harmless). The
          // previous bytes are kept in an on-disk backup so a failed install,
          // or a rerun after a crash, can put them back alongside the
          // lockfiles; a restored lockfile must match the manifest it was
          // resolved from.
          const packageJsonBackupPath = `${absolutePackageJsonPath}.nx-fhir-backup`;
          // A surviving backup holds the pre-migration manifest; the manifest
          // itself may already be migrated.
          const previousPackageJson = existsSync(packageJsonBackupPath)
            ? readFileSync(packageJsonBackupPath)
            : existsSync(absolutePackageJsonPath)
              ? readFileSync(absolutePackageJsonPath)
              : undefined;
          if (previousPackageJson !== undefined) {
            writeFileSync(packageJsonBackupPath, previousPackageJson);
          }
          writeFileSync(absolutePackageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

          const lockfileBackups: Array<{ original: string; backup: string }> =
            [];
          for (const { original, backup } of lockfileCandidates) {
            // A backup without its original is the sole copy left by an
            // interrupted run; it already sits in the backup slot.
            if (existsSync(backup)) {
              lockfileBackups.push({ original, backup });
              continue;
            }
            try {
              renameSync(original, backup);
              lockfileBackups.push({ original, backup });
            } catch (error) {
              // ENOENT: no lockfile of this name in this directory.
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
            }
          }
          // The module tree is moved aside so a failed install can put the
          // previous dependencies back.
          let nodeModulesMoved = false;
          if (existsSync(nodeModulesBackup)) {
            // The sole copy from an interrupted run already sits in the
            // backup slot.
            nodeModulesMoved = true;
          } else {
            try {
              renameSync(nodeModulesPath, nodeModulesBackup);
              nodeModulesMoved = true;
            } catch (error) {
              // ENOENT: no module tree to move.
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
            }
          }
          logger.info(`Installing updated dependencies for '${projectName}'...`);
          try {
            execSync(getInstallCommand(packageManager), {
              stdio: 'inherit',
              cwd: projectAbsPath,
            });
          } catch (error) {
            if (previousPackageJson !== undefined) {
              writeFileSync(absolutePackageJsonPath, previousPackageJson);
            }
            rmSync(packageJsonBackupPath, { force: true });
            for (const { original, backup } of lockfileBackups) {
              renameSync(backup, original);
            }
            // A failed install can leave a partial module tree; remove it
            // before the previous one goes back.
            rmSync(nodeModulesPath, { recursive: true, force: true });
            if (nodeModulesMoved) {
              renameSync(nodeModulesBackup, nodeModulesPath);
            }
            throw error;
          }
          for (const { backup } of lockfileBackups) {
            rmSync(backup, { force: true });
          }
          rmSync(nodeModulesBackup, { recursive: true, force: true });
          rmSync(packageJsonBackupPath, { force: true });
        }
      }

      const hasConflicts = summary.conflicts > 0;

      // Update project configuration
      projectConfig.frontendVersion = toVersion;
      projectConfig.pluginVersion = PLUGIN_VERSION;
      updateProjectConfiguration(tree, projectName, projectConfig);

      logMigrationSummary(summary, fromVersion, toVersion);

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
