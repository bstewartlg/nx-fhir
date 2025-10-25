import {
  addProjectConfiguration,
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
import { ServerProjectConfiguration } from '../../shared/models';
import { registerNxPlugin, removeServerYamlProperty } from '../../shared/utils';

export async function frontendGenerator(
  tree: Tree,
  options: FrontendGeneratorSchema
) {
  const projectRoot = `${options.name}`;

  // Ensure project root does not already exist
  if (tree.exists(projectRoot)) {
    logger.error(`Directory '${projectRoot}' already exists. Aborting.`);
    return;
  }

  const isDryRun = process.argv.includes('--dry-run');

  // Run Next.js generator to bootstrap the frontend. Pinning the version to 15.x currently until MUI supports 16: https://github.com/mui/material-ui/issues/47109
  const generateCommand = `npx --yes create-next-app@15 ${projectRoot} --ts --app --tailwind --turbopack --src-dir --eslint --yes`;

  if (isDryRun) {
    logger.info(`[Dry Run] Would execute: ${generateCommand}`);
    // Simulate creation of project directory
    tree.write(`${projectRoot}/package.json`, '{}');
  } else {
    logger.info(`Running: ${generateCommand}`);
    execSync(generateCommand, {
      stdio: 'inherit',
      cwd: tree.root,
    });
  }

  // Additional dependencies our custom frontend uses
  const frontendPackageJson = readJson(tree, `${projectRoot}/package.json`);
  frontendPackageJson.dependencies = {
    ...frontendPackageJson.dependencies,
    '@emotion/cache': '^11.14.0',
    '@emotion/react': '^11.14.0',
    '@emotion/styled': '^11.14.1',
    '@monaco-editor/react': '^4.7.0',
    '@mui/icons-material': '^7.3.4',
    '@mui/material': '^7.3.4',
    '@mui/material-nextjs': '^7.3.3',
    '@mui/x-data-grid': '^8.14.1',
  };
  frontendPackageJson.devDependencies = {
    ...frontendPackageJson.devDependencies,
    '@testing-library/dom': '^10.4.1',
    '@testing-library/react': '^16.3.0',
    '@types/fhir': '^0.0.41',
    '@vitejs/plugin-react': '^5.1.0',
    '@vitest/coverage-v8': '^4.0.3',
    jsdom: '^27.0.1',
    'vite-tsconfig-paths': '^5.1.4',
    vitest: '^4.0.2',
  };

  // Add test script to package.json
  frontendPackageJson.scripts = {
    ...frontendPackageJson.scripts,
    test: 'vitest',
  };

  // Write the updated package.json
  writeJson(tree, `${projectRoot}/package.json`, frontendPackageJson);

  // Clear out the /public directory
  tree.children(`${projectRoot}/public`).forEach((file) => {
    tree.delete(`${projectRoot}/public/${file}`);
  });

  // Create the frontend project config
  const projectConfig: ProjectConfiguration = {
    root: projectRoot,
    projectType: 'application',
    sourceRoot: `${projectRoot}/src`,
    tags: ['nx-fhir-frontend', 'fhir', 'frontend', 'client'],
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

  // Re-run npm install after generating files to get all of the new dependencies
  return () => {
    logger.info(`Installing additional dependencies for '${options.name}'...`);
    execSync(`npm install`, {
      stdio: 'inherit',
      cwd: `${tree.root}/${projectRoot}`,
    });
  };
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
  const frontendPackageJson = readJson(
    tree,
    `${frontendProject.root}/package.json`
  );

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
        `cpy 'out/**' ../${serverProject.root}/src/main/resources/static --cwd=.`,
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
  generateFiles(
    tree,
    path.join(__dirname, 'files/docker'),
    path.join(frontendProject.root, '../'),
    {
      frontendRoot: frontendProject.root,
      serverRoot: serverProject.root,
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
