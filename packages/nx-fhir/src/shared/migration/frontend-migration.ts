import {
  detectPackageManager,
  logger,
  Tree,
  getProjects,
  readJson,
  updateProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
import { migrateWithThreeWayMerge, logMigrationSummary, MigrationSummary, getAllFiles } from '../utils/merge';
import { FrontendProjectConfiguration } from '../models';
import { PLUGIN_VERSION } from '../constants/versions';
import { FRONTEND_TEMPLATE_CONFIG, getFrontendDependencies } from '../../generators/frontend/frontend';
import { getInstallCommand } from '../utils/package-manager';
import { ProjectMigrationResult } from './hapi-migration';

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

  execFileSync('tar', ['xzf', tarballPath, '-C', extractDir], { stdio: 'pipe' });

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
        let content = readFileSync(srcPath, 'utf-8');
        content = content.replace(/<%=\s*([^%]+?)\s*%>/g, (_, expr) => {
          const trimmed = expr.trim();
          return String(vars[trimmed] ?? '');
        });
        writeFileSync(destPath, content);
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
      // Old versions didn't have appTitle/bgLight/bgDark as template variables.
      // The .template files used hardcoded values, so rendering without those
      // vars preserves the original output.
      const oldVars: Record<string, string> = { name: projectName };
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
      const summary = migrateWithThreeWayMerge(
        tree,
        projectConfig.root,
        tempOld,
        tempNew,
        fromVersion,
        toVersion
      );

      // Sync package.json dependencies with current template
      const projectPackageJsonPath = `${projectConfig.root}/package.json`;
      if (tree.exists(projectPackageJsonPath)) {
        const packageJson = readJson(tree, projectPackageJsonPath);
        const templateDeps = getFrontendDependencies(template);

        packageJson.dependencies = { ...packageJson.dependencies, ...templateDeps.dependencies };
        packageJson.devDependencies = { ...packageJson.devDependencies, ...templateDeps.devDependencies };

        writeJson(tree, projectPackageJsonPath, packageJson);

        // Write package.json to disk immediately so we can run the install now.
        // The tree flush will later write the same content (harmless).
        const absolutePackageJsonPath = join(tree.root, projectPackageJsonPath);
        writeFileSync(absolutePackageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

        const packageManager = detectPackageManager();
        const projectAbsPath = join(tree.root, projectConfig.root);
        logger.info(`Installing updated dependencies for '${projectName}'...`);
        execSync(getInstallCommand(packageManager), {
          stdio: 'inherit',
          cwd: projectAbsPath,
        });
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
