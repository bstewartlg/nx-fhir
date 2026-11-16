import {
  addProjectConfiguration,
  detectPackageManager,
  generateFiles,
  getProjects,
  joinPathFragments,
  logger,
  ProjectConfiguration,
  readJson,
  readProjectConfiguration,
  Tree,
  updateJson,
  updateProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import { FrontendGeneratorSchema } from './schema';
import { execSync } from 'child_process';
import { confirm, select } from '@inquirer/prompts';
import path = require('path');
import { runFeature } from '../feature/run-feature';
import { FRONTEND_PROXY_FEATURE, writeDevServerEnv } from '../feature-frontend-proxy/frontend-proxy';
import { FrontendProjectConfiguration, ServerProjectConfiguration } from '../../shared/models';
import { registerNxPlugin, removeTesterSection } from '../../shared/utils';
import { isInteractive } from '../../shared/utils/interactive';
import { getInstallCommand } from '../../shared/utils/package-manager';
import { CURRENT_FRONTEND_VERSION } from '../../shared/migration/frontend-migration-resolver';
import {
  frontendDockerVars,
  integrationDockerFileNames,
} from '../../shared/utils/frontend-integration';
import {
  appendDockerignoreLines,
  DockerFragments,
  frontendStageBuilds,
  insertFrontendLines,
  isServerRootLayout,
  removeFrontendLines,
  renderDockerFragments,
} from '../../shared/utils/docker-splice';

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
  '@radix-ui/react-collapsible': '^1.2.1',
  '@radix-ui/react-scroll-area': '^1.4.0',
  '@radix-ui/react-tabs': '^1.2.1',
  '@tailwindcss/vite': '^4.3.5',
  '@tanstack/react-devtools': '^0.10.14',
  '@tanstack/react-query': '^5.107.1',
  '@tanstack/react-router': '^1.170.46',
  '@tanstack/react-router-devtools': '^1.167.3',
  '@tanstack/react-table': '^9.3.1',
  '@tanstack/router-plugin': '^1.169.0',
  'class-variance-authority': '^0.7.1',
  'clsx': '^2.1.1',
  'lucide-react': '^1.72.0',
  '@monaco-editor/react': '^4.7.0',
  'radix-ui': '^1.8.1',
  'react': '^19.3.1',
  'react-dom': '^19.3.1',
  'sonner': '^2.0.8',
  'tailwind-merge': '^3.7.0',
  'tailwindcss': '^4.3.5',
  'tw-animate-css': '^1.4.0',
};

/** Dependencies only needed by the browser template */
export const BROWSER_ONLY_DEPENDENCIES: Record<string, string> = {
  '@tanstack/react-virtual': '^3.14.26',
  'cmdk': '^1.1.1',
};

/** Dev dependencies for all frontend templates */
export const DEV_DEPENDENCIES: Record<string, string> = {
  '@biomejs/biome': '2.6.7',
  '@tanstack/devtools-vite': '^0.8.6',
  '@testing-library/dom': '^10.4.2',
  '@testing-library/jest-dom': '~6.9.1',
  '@testing-library/react': '^16.3.3',
  '@types/fhir': '^0.0.44',
  '@types/node': '^26.6.6',
  '@types/react': '^19.3.0',
  '@types/react-dom': '^19.3.0',
  '@vitejs/plugin-react': '^6.3.0',
  'jsdom': '^29.1.1',
  'typescript': '~6.0.3',
  'vite': '^8.3.8',
  'vitest': '^4.1.12',
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
    if (isInteractive()) {
      navigationLayout = await select({
        message: 'Which navigation layout would you like?',
        choices: [
          { name: 'Sidebar - Collapsible left navigation for many pages', value: 'sidebar' as const },
          { name: 'Top Navigation - Horizontal nav bar for few entry pages', value: 'topnav' as const },
        ],
        default: 'sidebar',
      });
    } else {
      logger.info(
        "No terminal available to choose a navigation layout. Using 'sidebar'. Pass --navigationLayout=topnav for the top navigation layout."
      );
    }
  }

  if (tree.exists(projectRoot)) {
    logger.error(`Directory '${projectRoot}' already exists. Aborting.`);
    return;
  }

  const packageManager = detectPackageManager(tree.root);
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

  const templateVars = { ...options, ...FRONTEND_TEMPLATE_CONFIG[template], dot: '.' };

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
  const integratedServer = await integrateFrontendWithServer(tree, projectConfig, options);
  if (integratedServer) {
    await addFrontendProxy(tree, integratedServer, projectRoot, options.proxy);
  } else if (options.proxy) {
    logger.warn(
      'The proxy option needs a server project that the frontend is integrated with. The generator does not install the proxy.'
    );
  }

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
  updateJson(tree, 'package.json', (packageJson) => {
    packageJson.workspaces ??= [];
    const ws = packageJson.workspaces;
    // The workspaces field is either a pattern array or an object with a packages array.
    const patterns: string[] = Array.isArray(ws) ? ws : (ws.packages ??= []);
    if (!patterns.includes(projectRoot)) {
      patterns.push(projectRoot);
    }
    return packageJson;
  });
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
 * Installs the frontend-proxy feature on the integrated server. The feature
 * reads the frontend files, the copy-to-server target, and the server
 * integration files from the tree, so it runs after the integration.
 */
async function addFrontendProxy(
  tree: Tree,
  serverName: string,
  frontendRoot: string,
  proxyOption: boolean | undefined
): Promise<void> {
  // A server with the feature sends every frontend it serves through the proxy in production.
  // Without the env line, the new frontend skips the proxy in development.
  const serverProject = readProjectConfiguration(tree, serverName) as ServerProjectConfiguration;
  if (serverProject.features?.[FRONTEND_PROXY_FEATURE]) {
    writeDevServerEnv(tree, frontendRoot);
    logger.info(
      `Server project '${serverName}' already has the frontend proxy. Frontend '${frontendRoot}' is set up to use it.`
    );
    return;
  }

  const proxy =
    proxyOption ??
    (isInteractive()
      ? await confirm({ message: 'Route requests to other servers through this server?', default: false })
      : false);
  if (!proxy) {
    return;
  }

  try {
    await runFeature(tree, { feature: FRONTEND_PROXY_FEATURE, project: serverName });
  } catch (error) {
    // Ctrl+C at a feature prompt stops the run. It is not a refusal of the install.
    if ((error as Error).name === 'ExitPromptError') {
      throw error;
    }
    logger.warn(
      `Skipped the install of feature '${FRONTEND_PROXY_FEATURE}' on server project '${serverName}'. ` +
        `The frontend is generated without the proxy. Reason: ${(error as Error).message}`
    );
  }
}

/**
 * Integrate frontend build output with the selected server project.
 * Returns the name of the integrated server project, or undefined when the
 * frontend is not integrated.
 */
async function integrateFrontendWithServer(
  tree: Tree,
  frontendProject: ProjectConfiguration,
  options: FrontendGeneratorSchema
): Promise<string | undefined> {
  // The choice stays local so the caller's options object is left as it was passed.
  let server = options.server;

  // Prompt to integrate with a server project if not already specified
  if (!server) {
    try {
      getProjects(tree);
      const serverProjects = Array.from(getProjects(tree).entries()).filter(
        ([, project]) =>
          project.projectType === 'application' &&
          project.tags?.includes('fhir') &&
          project.tags?.includes('server')
      );

      if (serverProjects.length > 0 && !isInteractive()) {
        // Integration edits the server's files, so a run without a terminal
        // never picks a server on its own.
        logger.info(
          `No terminal available to select a server project (${serverProjects.map(([projectName]) => projectName).join(', ')}). ` +
            'Skipping integration. Pass --server=<name> to integrate the frontend with one of them.'
        );
        return;
      }

      if (serverProjects.length > 0) {
        // The value is the project name because the lookup below is by name.
        // An imported server's name differs from its root, which is often '.'.
        const choices = serverProjects.map(([projectName, project]) => ({
          name: `${projectName} (${project.root})`,
          value: projectName,
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
    rimraf: '^6.1.3',
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
  const dockerVars = await frontendDockerVars(tree, frontendProject.root, serverProject.root);
  if (isServerRootLayout(serverProject.root, frontendProject.root)) {
    const fragments = renderDockerFragments(path.join(__dirname, 'files'), dockerVars);
    if (fragments === null) {
      throw new Error('The docker fragments are missing from the nx-fhir package.');
    }
    spliceStarterDockerFiles(tree, serverProject.root, frontendProject.root, fragments);
  } else {
    // The combined frontend + server Dockerfile lands in the frontend
    // project's parent directory, which can already hold docker files.
    // Preserve anything that is about to be replaced under an .orig name. A
    // backup left by an earlier run is kept, since it holds the
    // pre-integration original.
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

    generateFiles(tree, path.join(__dirname, 'files/docker'), dockerOutputDir, dockerVars);
  }

  // Remove the hapi.fhir.tester section from application.yaml and from every
  // profile file. This will prevent Thymeleaf from overriding serving from
  // resources/static by default. Any tester entry left in a profile file keeps
  // the tester enabled, and an entry whose name came from application.yaml
  // stops HAPI at startup. The section is spliced out by line, so the rest of
  // each file keeps the exact bytes that later server migrations merge against.
  const resourcesRoot = path.join(serverProject.root, 'src/main/resources');
  for (const fileName of tree.children(resourcesRoot)) {
    if (!/^application(-[^.]+)?\.ya?ml$/.test(fileName)) {
      continue;
    }
    const yamlPath = path.join(resourcesRoot, fileName);
    const yaml = tree.read(yamlPath, 'utf-8') ?? '';
    const withoutTester = removeTesterSection(yaml);
    if (withoutTester !== yaml) {
      tree.write(yamlPath, withoutTester);
    }
  }

  logger.info(
    `Frontend project '${frontendProject.root}' integrated with server project '${serverProject.root}'.`
  );
  return server;
}

/**
 * Adds the frontend lines to the HAPI starter's own Dockerfile and
 * .dockerignore. The starter's lines keep their bytes, so a server migration
 * merges starter updates into these files.
 */
function spliceStarterDockerFiles(
  tree: Tree,
  serverRoot: string,
  frontendRoot: string,
  fragments: DockerFragments
): void {
  const dockerfilePath = joinPathFragments(serverRoot, 'Dockerfile');
  const dockerignorePath = joinPathFragments(serverRoot, '.dockerignore');
  const dockerfile = tree.read(dockerfilePath, 'utf-8');

  if (dockerfile !== null && removeFrontendLines(dockerfile) !== null) {
    if (frontendStageBuilds(dockerfile, frontendRoot)) {
      logger.info(
        `${dockerfilePath} already has a build-frontend stage. ` +
          `The generator does not change ${dockerfilePath} or ${dockerignorePath}.`
      );
    } else {
      logger.warn(
        `${dockerfilePath} has a build-frontend stage for a frontend other than '${frontendRoot}'. ` +
          'The server image builds only the frontend that is already in the stage. ' +
          `The generator does not change ${dockerfilePath} or ${dockerignorePath}.`
      );
    }
    return;
  }

  const spliced = dockerfile === null ? null : insertFrontendLines(dockerfile, fragments);
  if (spliced === null) {
    const reason =
      dockerfile === null
        ? `${dockerfilePath} does not exist.`
        : `${dockerfilePath} has no FROM line or no COPY src/ line.`;
    logger.warn(
      [
        `${reason} The generator does not change ${dockerfilePath} or ${dockerignorePath}.`,
        'To build the frontend into the server image, add these lines by hand.',
        `Above the first FROM line of ${dockerfilePath}:`,
        fragments.frontendStage.trimEnd(),
        `After the COPY src/ line of ${dockerfilePath}:`,
        fragments.copyFrontend.trimEnd(),
        `At the end of ${dockerignorePath}:`,
        fragments.dockerignoreLines.trimEnd(),
      ].join('\n')
    );
    return;
  }

  tree.write(dockerfilePath, spliced);
  tree.write(
    dockerignorePath,
    appendDockerignoreLines(tree.read(dockerignorePath, 'utf-8') ?? '', fragments.dockerignoreLines)
  );
}
export default frontendGenerator;
