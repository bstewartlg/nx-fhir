import {
  addDependenciesToPackageJson,
  addProjectConfiguration,
  formatFiles,
  generateFiles,
  getProjects,
  ProjectConfiguration,
  readJson,
  readProjectConfiguration,
  Tree,
  updateProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import { FrontendGeneratorSchema } from './schema';
import { execSync } from 'child_process';
import { select } from '@inquirer/prompts';
import path = require('path');
import { ServerProjectConfiguration } from '../../shared/models';
import { removeServerYamlProperty, updateServerYaml } from '../../shared/utils';

export async function frontendGenerator(
  tree: Tree,
  options: FrontendGeneratorSchema
) {
  const projectRoot = `${options.name}`;

  // Ensure project root does not already exist
  if (tree.exists(projectRoot)) {
    console.error(`Directory '${projectRoot}' already exists. Aborting.`);
    return;
  }

  // Run Next.js generator to bootstrap the frontend. Pegging the version to 15.x currently.
  console.log('Running:', `npx --yes create-next-app@15 ${projectRoot} --ts --app --tailwind --turbopack --src-dir --eslint --yes`);
  execSync(`npx --yes create-next-app@15 ${projectRoot} --ts --app --tailwind --turbopack --src-dir --eslint --yes`, {
    stdio: 'inherit',
    cwd: tree.root,
  });

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
    '@types/fhir': '^0.0.41',
  };
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
    targets: {
      start: {
        executor: 'nx:run-commands',
        options: {
          command: 'npm run dev',
          cwd: `${projectRoot}`,
        },
      },
      build: {
        executor: 'nx:run-commands',
        options: {
          command: 'npm run build',
          cwd: `${projectRoot}`,
        },
        outputs: [`{workspaceRoot}/${projectRoot}/out`],
      },
    },
    tags: ['fhir', 'frontend', 'client'],
  };
  addProjectConfiguration(tree, options.name, projectConfig);

  generateFiles(
    tree,
    path.join(__dirname, 'files/webapp'),
    projectRoot,
    options
  );

  console.log(`Frontend project '${options.name}' has been created.`);

  // Perform possible integration with a server project
  await integrateFrontendWithServer(tree, projectConfig, options);

  // Format all the files that were created
  await formatFiles(tree);

  // Re-run npm install after generating files to get all of the new dependencies
  return () => {
    console.log(`Installing additional dependencies for '${options.name}'...`);
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
        console.log('No FHIR server projects found in the workspace.');
      }
    } catch (error) {
      console.error('Error selecting server project:', error);
    }
  }

  // Still not server to integrate with, nothing more to do
  if (!options.server) {
    console.log(
      'No server project selected for integration. Skipping integration step.'
    );
    return;
  }

  const serverProject = getProjects(tree).get(
    options.server
  ) as ServerProjectConfiguration;

  if (!serverProject) {
    console.error(`Server project '${options.server}' not found.`);
    return;
  }

  console.log(
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
  frontendProject.targets['copy-to-server'] = {
    executor: 'nx:run-commands',
    dependsOn: ['build'],
    options: {
      commands: [
        `npx rimraf ${serverProject.name}/src/main/resources/static/*`,
        `npx cpy '${frontendProject.name}/out/**' ${serverProject.name}/src/main/resources/static --parents --cwd=.`,
      ],
      parallel: false,
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
    path.join(serverProject.root, `src/main/java/${serverProject.packageBase.replace(/\./g, '/')}`),
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
  removeServerYamlProperty(
    serverProject.root,
    tree,
    'hapi.fhir.tester'
  );

  console.log(
    `Frontend project '${frontendProject.root}' integrated with server project '${serverProject.root}'.`
  );

}
export default frontendGenerator;
