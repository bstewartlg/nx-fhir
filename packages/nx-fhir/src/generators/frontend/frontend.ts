import {
  addProjectConfiguration,
  detectPackageManager,
  generateFiles,
  getProjects,
  logger,
  ProjectConfiguration,
  readJson,
  Tree,
  updateProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import { FrontendGeneratorSchema } from './schema';
import { execSync } from 'child_process';
import { select } from '@inquirer/prompts';
import path = require('path');
import { FrontendProjectConfiguration, ServerProjectConfiguration } from '../../shared/models';
import { registerNxPlugin, removeTesterSection } from '../../shared/utils';
import {
  getCiInstallCommand,
  getDockerBaseImage,
  getInstallCommand,
  getLockfileName,
  getRunCommand,
} from '../../shared/utils/package-manager';
import { CURRENT_FRONTEND_VERSION } from '../../shared/migration/frontend-migration-resolver';
import { integrationDockerFileNames } from '../../shared/utils/frontend-integration';

/**
 * Template-specific configuration for frontend projects.
 * Used by both the frontend generator and migration runner.
 */
export const FRONTEND_TEMPLATE_CONFIG: Record<string, { appTitle: string; bgLight: string; bgDark: string }> = {
  browser: { appTitle: 'FHIR Browser', bgLight: '#f9fafb', bgDark: '#171717' },
  clinical: { appTitle: 'Clinical Portal', bgLight: '#fafafa', bgDark: '#18181b' },
};

/** Dependencies shared by all frontend templates */
export const BASE_DEPENDENCIES: Record<string, string> = {
  '@radix-ui/react-collapsible': '^1.1.20',
  '@radix-ui/react-scroll-area': '^1.2.18',
  '@radix-ui/react-tabs': '^1.1.21',
  '@tailwindcss/vite': '^4.3.3',
  '@tanstack/react-devtools': '^0.10.9',
  '@tanstack/react-query': '^5.101.4',
  '@tanstack/react-router': '^1.170.25',
  '@tanstack/react-router-devtools': '^1.167.1',
  '@tanstack/react-table': '^9.1.2',
  '@tanstack/router-plugin': '^1.168.29',
  'class-variance-authority': '^0.7.1',
  'clsx': '^2.1.1',
  'lucide-react': '^1.31.0',
  '@monaco-editor/react': '^4.7.0',
  'radix-ui': '^1.6.7',
  'react': '^19.2.8',
  'react-dom': '^19.2.8',
  'sonner': '^2.0.8',
  'tailwind-merge': '^3.6.0',
  'tailwindcss': '^4.3.3',
  'tw-animate-css': '^1.4.0',
};

/** Dependencies only needed by the browser template */
export const BROWSER_ONLY_DEPENDENCIES: Record<string, string> = {
  '@tanstack/react-virtual': '^3.14.9',
  'cmdk': '^1.1.1',
};

/** Dev dependencies for all frontend templates */
export const DEV_DEPENDENCIES: Record<string, string> = {
  '@biomejs/biome': '2.5.7',
  '@tanstack/devtools-vite': '^0.8.3',
  '@testing-library/dom': '^10.4.1',
  '@testing-library/jest-dom': '~6.9.1',
  '@testing-library/react': '^16.3.2',
  '@types/fhir': '^0.0.44',
  '@types/node': '^26.2.0',
  '@types/react': '^19.2.18',
  '@types/react-dom': '^19.2.4',
  '@vitejs/plugin-react': '^6.0.5',
  'jsdom': '^29.1.1',
  'typescript': '~6.0.3',
  'vite': '^8.2.0',
  'vitest': '^4.1.10',
};

/**
 * Returns the full set of dependencies for a given frontend template.
 * Used by both the generator (new projects) and migration (updating existing projects).
 */
export function getFrontendDependencies(template: string): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  const dependencies = template === 'browser'
    ? { ...BASE_DEPENDENCIES, ...BROWSER_ONLY_DEPENDENCIES }
    : { ...BASE_DEPENDENCIES };
  return { dependencies, devDependencies: { ...DEV_DEPENDENCIES } };
}

export async function frontendGenerator(
  tree: Tree,
  options: FrontendGeneratorSchema
) {
  const projectRoot = `${options.name}`;
  const template = options.template ?? 'browser';

  let navigationLayout = options.navigationLayout ?? 'sidebar';
  if (template === 'clinical' && !options.navigationLayout) {
    navigationLayout = await select({
      message: 'Which navigation layout would you like?',
      choices: [
        { name: 'Sidebar - Collapsible left navigation for many pages', value: 'sidebar' as const },
        { name: 'Top Navigation - Horizontal nav bar for few entry pages', value: 'topnav' as const },
      ],
      default: 'sidebar',
    });
  }

  if (tree.exists(projectRoot)) {
    logger.error(`Directory '${projectRoot}' already exists. Aborting.`);
    return;
  }

  const packageManager = detectPackageManager();
  const { dependencies, devDependencies } = getFrontendDependencies(template);

  const packageJson = {
    name: options.name,
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite --port 3000',
      build: 'vite build && tsc',
      preview: 'vite preview',
      test: 'vitest run',
      format: 'biome format',
      lint: 'biome lint',
      check: 'biome check',
    },
    dependencies,
    devDependencies,
  };

  writeJson(tree, `${projectRoot}/package.json`, packageJson);

  const pluginVersion = getPluginVersion();
  const tags = ['nx-fhir-frontend', 'fhir', 'frontend', 'client'];
  if (template === 'clinical') {
    tags.push('clinical');
  }

  const projectConfig: FrontendProjectConfiguration = {
    root: projectRoot,
    projectType: 'application',
    sourceRoot: `${projectRoot}/src`,
    tags,
    frontendVersion: CURRENT_FRONTEND_VERSION,
    frontendTemplate: template,
    navigationLayout: template === 'clinical' ? navigationLayout : undefined,
    pluginVersion,
  };
  addProjectConfiguration(tree, options.name, projectConfig);

  const templateVars = { ...options, ...FRONTEND_TEMPLATE_CONFIG[template] };

  // Shared foundation (config, UI components, hooks, lib)
  generateFiles(tree, path.join(__dirname, 'files/common'), projectRoot, templateVars);

  // Template-specific files (routes, styling, unique components)
  generateFiles(tree, path.join(__dirname, `files/${template}`), projectRoot, templateVars);

  // Resolve navigation layout variant for clinical template
  if (template === 'clinical') {
    const variantFile = navigationLayout === 'topnav'
      ? `${projectRoot}/_variants/__root-topnav.tsx`
      : `${projectRoot}/_variants/__root-sidebar.tsx`;
    const rootContent = tree.read(variantFile, 'utf-8');
    if (rootContent === null) {
      throw new Error(`Navigation layout variant file not found: ${variantFile}`);
    }
    tree.write(`${projectRoot}/src/routes/__root.tsx`, rootContent);

    tree.delete(`${projectRoot}/_variants/__root-sidebar.tsx`);
    tree.delete(`${projectRoot}/_variants/__root-topnav.tsx`);

    if (navigationLayout === 'topnav') {
      tree.delete(`${projectRoot}/src/components/app-sidebar.tsx`);
      tree.delete(`${projectRoot}/src/components/ui/sidebar.tsx`);
      tree.delete(`${projectRoot}/src/components/ui/sheet.tsx`);
    }
  }

  // Add frontend project to root package.json workspaces
  addToWorkspaces(tree, projectRoot);

  logger.info(`Frontend project '${options.name}' has been created.`);

  // Perform possible integration with a server project
  await integrateFrontendWithServer(tree, projectConfig, options);

  // Ensure nx-fhir plugin is registered
  registerNxPlugin(tree);

  // The rendered template files are deliberately left exactly as rendered.
  // Frontend migrations three-way merge against a fresh render of the old and
  // new templates, so reformatting here would make every file differ from the
  // merge base by formatting alone.

  // Re-run package install after generating files to get all of the new dependencies
  return () => {
    logger.info(`Installing dependencies for '${options.name}'...`);
    execSync(`${getInstallCommand(packageManager)}`, {
      stdio: 'inherit',
      cwd: `${tree.root}/${projectRoot}`,
    });
  };
}

function addToWorkspaces(tree: Tree, projectRoot: string) {
  const packageJson = readJson(tree, 'package.json');
  if (!packageJson.workspaces) {
    packageJson.workspaces = [];
  }
  if (!packageJson.workspaces.includes(projectRoot)) {
    packageJson.workspaces.push(projectRoot);
    writeJson(tree, 'package.json', packageJson);
  }
}

function getPluginVersion(): string {
  try {
    const packageJson = require('../../../package.json');
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Integrate frontend build output with the selected server project
 */
async function integrateFrontendWithServer(
  tree: Tree,
  frontendProject: ProjectConfiguration,
  options: FrontendGeneratorSchema
) {
  // The choice stays local so the caller's options object is left as it was passed.
  let server = options.server;

  // Prompt to integrate with a server project if not already specified
  if (!server) {
    try {
      getProjects(tree);
      const serverProjects = Array.from(getProjects(tree).values()).filter(
        (project) =>
          project.projectType === 'application' &&
          project.tags?.includes('fhir') &&
          project.tags?.includes('server')
      );

      if (serverProjects.length > 0) {
        const choices = serverProjects.map((project) => ({
          name: project.root,
          value: project.root,
        }));
        choices.push({ name: 'None', value: 'none' });

        const selectedServer = await select({
          message:
            'Select a FHIR server project to integrate with the frontend:',
          choices,
        });

        if (selectedServer !== 'none') {
          server = selectedServer;
        }
      } else {
        logger.info('No FHIR server projects found in the workspace.');
      }
    } catch (error) {
      logger.error(`Error selecting server project: ${error}`);
    }
  }

  // Still not server to integrate with, nothing more to do
  if (!server) {
    logger.info(
      'No server project selected for integration. Skipping integration step.'
    );
    return;
  }

  const serverProject = getProjects(tree).get(
    server
  ) as ServerProjectConfiguration;

  if (!serverProject) {
    logger.error(`Server project '${server}' not found.`);
    return;
  }

  logger.info(
    `Integrating frontend with server project in ${serverProject.root}`
  );
  // Add necessary dependencies for frontend build and copy
  const frontendPackageJson = readJson(tree, `${frontendProject.root}/package.json`);

  frontendPackageJson.devDependencies = {
    ...frontendPackageJson.devDependencies,
    'cpy-cli': '^6.0.0',
    rimraf: '^6.0.0',
  };
  writeJson(tree, `${frontendProject.root}/package.json`, frontendPackageJson);

  // Add copy-to-server target to frontend project
  if (!frontendProject.targets) {
    frontendProject.targets = {};
  }
  frontendProject.targets['copy-to-server'] = {
    executor: 'nx:run-commands',
    dependsOn: ['build'],
    options: {
      // Double quotes and --glob keep these commands working under cmd.exe,
      // which passes single quotes literally and never expands globs
      commands: [
        `rimraf --glob "../${serverProject.root}/src/main/resources/static/*"`,
        `cpy "dist/**" "../${serverProject.root}/src/main/resources/static" --cwd=.`,
      ],
      parallel: false,
      cwd: frontendProject.root,
    },
  };
  updateProjectConfiguration(tree, options.name, frontendProject);

  // Ensure we have a static resources directory in the server project
  const staticResourcesDir = `${serverProject.root}/src/main/resources/static`;
  if (!tree.exists(staticResourcesDir)) {
    tree.write(`${staticResourcesDir}/.gitkeep`, '');
  }

  // Generate Java and Docker files
  generateFiles(
    tree,
    path.join(__dirname, 'files/server'),
    path.join(
      serverProject.root,
      `src/main/java/${serverProject.packageBase.replace(/\./g, '/')}`
    ),
    { packageBase: serverProject.packageBase }
  );
  // The docker files land in the frontend project's parent directory. When
  // the server was imported at the workspace root the frontend usually lives
  // directly beneath it, so the combined frontend + server Dockerfile would
  // silently overwrite the starter's own docker files. Preserve anything that
  // is about to be replaced under an .orig name; a backup left by an earlier
  // run is kept, since it holds the pre-integration original.
  const dockerOutputDir = path.join(frontendProject.root, '../');
  for (const fileName of integrationDockerFileNames()) {
    const existingFile = path.join(dockerOutputDir, fileName);
    const backupFile = `${existingFile}.orig`;
    if (tree.exists(existingFile) && !tree.exists(backupFile)) {
      tree.rename(existingFile, backupFile);
      logger.warn(
        `Existing ${fileName} in '${dockerOutputDir}' was preserved as ${fileName}.orig ` +
          'and replaced by the combined frontend + server version.'
      );
    }
  }

  const packageManager = detectPackageManager();
  generateFiles(
    tree,
    path.join(__dirname, 'files/docker'),
    path.join(frontendProject.root, '../'),
    {
      dot: '.',
      frontendRoot: frontendProject.root,
      serverRoot: serverProject.root,
      dockerBaseImage: getDockerBaseImage(packageManager),
      lockfileName: getLockfileName(packageManager),
      ciInstallCommand: getCiInstallCommand(packageManager),
      buildCommand: getRunCommand(packageManager, 'build'),
    }
  );

  // Modify the existing application.yaml to remove the hapi.fhir.tester section.
  // This will prevent Thymeleaf from overriding serving from resources/static by default.
  // The section is spliced out by line, so the rest of the file keeps the exact
  // upstream bytes that later server migrations merge against.
  const serverYamlPath = path.join(
    serverProject.root,
    'src/main/resources/application.yaml'
  );
  const serverYaml = tree.read(serverYamlPath, 'utf-8');
  if (serverYaml) {
    const withoutTester = removeTesterSection(serverYaml);
    if (withoutTester !== serverYaml) {
      tree.write(serverYamlPath, withoutTester);
    }
  }

  logger.info(
    `Frontend project '${frontendProject.root}' integrated with server project '${serverProject.root}'.`
  );
}
export default frontendGenerator;
