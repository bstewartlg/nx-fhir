import {
  addProjectConfiguration,
  detectPackageManager,
  formatFiles,
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
import { registerNxPlugin, removeServerYamlProperty } from '../../shared/utils';
import {
  getCiInstallCommand,
  getDockerBaseImage,
  getInstallCommand,
  getLockfileName,
  getRunCommand,
} from '../../shared/utils/package-manager';
import { CURRENT_FRONTEND_VERSION } from '../../shared/migration/frontend-migration-resolver';

export async function frontendGenerator(
  tree: Tree,
  options: FrontendGeneratorSchema
) {
  const projectRoot = `${options.name}`;

  if (tree.exists(projectRoot)) {
    logger.error(`Directory '${projectRoot}' already exists. Aborting.`);
    return;
  }

  const packageManager = detectPackageManager();

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
    dependencies: {
      '@monaco-editor/react': '^4.7.0',
      '@radix-ui/react-collapsible': '^1.1.12',
      '@radix-ui/react-scroll-area': '^1.2.10',
      '@radix-ui/react-tabs': '^1.1.13',
      '@tailwindcss/vite': '^4.1.18',
      '@tanstack/react-devtools': '^0.9.4',
      '@tanstack/react-query': '^5.90.20',
      '@tanstack/react-router': '^1.157.18',
      '@tanstack/react-router-devtools': '^1.157.18',
      '@tanstack/react-table': '^8.21.3',
      '@tanstack/react-virtual': '^3.13.18',
      '@tanstack/router-plugin': '^1.157.18',
      'class-variance-authority': '^0.7.1',
      'clsx': '^2.1.1',
      'cmdk': '^1.1.1',
      'lucide-react': '^0.563.0',
      'nuqs': '^2.8.7',
      'radix-ui': '^1.4.3',
      'react': '^19.2.4',
      'react-dom': '^19.2.4',
      'sonner': '^2.0.7',
      'tailwind-merge': '^3.4.0',
      'tailwindcss': '^4.1.18',
      'tw-animate-css': '^1.4.0',
    },
    devDependencies: {
      '@biomejs/biome': '2.3.13',
      '@tanstack/devtools-vite': '^0.5.0',
      '@testing-library/dom': '^10.4.1',
      '@testing-library/jest-dom': '^6.9.1',
      '@testing-library/react': '^16.3.2',
      '@types/fhir': '^0.0.41',
      '@types/node': '^25.1.0',
      '@types/react': '^19.2.10',
      '@types/react-dom': '^19.2.3',
      '@vitejs/plugin-react': '^5.1.2',
      jsdom: '^27.4.0',
      typescript: '^5.9.3',
      vite: '^7.3.1',
      'vite-tsconfig-paths': '^6.0.5',
      vitest: '^4.0.18',
    },
  };
  
  writeJson(tree, `${projectRoot}/package.json`, packageJson);

  const pluginVersion = getPluginVersion();
  // Create the frontend project config
  const projectConfig: FrontendProjectConfiguration = {
    root: projectRoot,
    projectType: 'application',
    sourceRoot: `${projectRoot}/src`,
    tags: ['nx-fhir-frontend', 'fhir', 'frontend', 'client'],
    frontendVersion: CURRENT_FRONTEND_VERSION,
    pluginVersion,
  };
  addProjectConfiguration(tree, options.name, projectConfig);

  generateFiles(
    tree,
    path.join(__dirname, 'files/webapp'),
    projectRoot,
    options
  );

  logger.info(`Frontend project '${options.name}' has been created.`);

  // Perform possible integration with a server project
  await integrateFrontendWithServer(tree, projectConfig, options);

  // Ensure nx-fhir plugin is registered
  registerNxPlugin(tree);

  // Format all the files that were created
  await formatFiles(tree);

  // Re-run package install after generating files to get all of the new dependencies
  return () => {
    logger.info(`Installing dependencies for '${options.name}'...`);
    execSync(`${getInstallCommand(packageManager)}`, {
      stdio: 'inherit',
      cwd: `${tree.root}/${projectRoot}`,
    });
  };
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
  // Prompt to integrate with a server project if not already specified
  if (!options.server) {
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
          options.server = selectedServer;
        }
      } else {
        logger.info('No FHIR server projects found in the workspace.');
      }
    } catch (error) {
      logger.error(`Error selecting server project: ${error}`);
    }
  }

  // Still not server to integrate with, nothing more to do
  if (!options.server) {
    logger.info(
      'No server project selected for integration. Skipping integration step.'
    );
    return;
  }

  const serverProject = getProjects(tree).get(
    options.server
  ) as ServerProjectConfiguration;

  if (!serverProject) {
    logger.error(`Server project '${options.server}' not found.`);
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
      commands: [
        `rimraf ../${serverProject.root}/src/main/resources/static/*`,
        `cpy 'dist/**' ../${serverProject.root}/src/main/resources/static --cwd=.`,
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
  const packageManager = detectPackageManager();
  generateFiles(
    tree,
    path.join(__dirname, 'files/docker'),
    path.join(frontendProject.root, '../'),
    {
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
  removeServerYamlProperty(serverProject.root, tree, 'hapi.fhir.tester');

  logger.info(
    `Frontend project '${frontendProject.root}' integrated with server project '${serverProject.root}'.`
  );
}
export default frontendGenerator;
