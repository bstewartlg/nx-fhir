import {
  readJsonFile,
  TargetConfiguration,
  joinPathFragments,
  CreateNodesV2,
  createNodesFromFiles,
  CreateNodesContextV2,
} from '@nx/devkit';
import { existsSync } from 'fs';
import { dirname } from 'path';

export interface NxFhirPluginOptions {}

/**
 * Nx project graph plugin
 */
export const createNodes: CreateNodesV2<NxFhirPluginOptions> = [
  '**/project.json',
  async (configFiles, options, context) => {
    return await createNodesFromFiles(
      (projectFile, options, context) =>
        createNodesInternal(projectFile, options, context),
      configFiles,
      options,
      context
    );
  },
];

export const createNodesV2 = createNodes;

async function createNodesInternal(
  configFilePath: string,
  options: NxFhirPluginOptions,
  context: CreateNodesContextV2
) {
  const projectRoot = dirname(configFilePath);

  // Check if this is an nx-fhir generated project by looking for project.json
  const projectJsonPath = joinPathFragments(
    context.workspaceRoot,
    projectRoot,
    'project.json'
  );

  if (!existsSync(projectJsonPath)) {
    return null;
  }

  try {
    const projectJson = readJsonFile(projectJsonPath);

    // Server project should have a pom.xml file in its root and include fhirVersion in the project configuration
    const pomXmlPath = joinPathFragments(projectRoot, 'pom.xml');
    if (
      existsSync(joinPathFragments(context.workspaceRoot, pomXmlPath)) &&
      projectJson.fhirVersion
    ) {
      return createServerProjectNodes(projectRoot, projectJson);
    }

    // Frontend project should have a package.json file in its root.
    const packageJsonPath = joinPathFragments(projectRoot, 'package.json');
    if (
      existsSync(joinPathFragments(context.workspaceRoot, packageJsonPath))
    ) {

      // package.json should include the @types/fhir dev dependency or the nx-fhir-frontend tag in the project configuration
      const packageJson = readJsonFile(joinPathFragments(context.workspaceRoot, packageJsonPath));
      if (
        (packageJson.devDependencies && packageJson.devDependencies['@types/fhir']) ||
        (packageJson.tags && packageJson.tags.includes('nx-fhir-frontend'))
      ) {
        return createFrontendProjectNodes(projectRoot, projectJson);
      }
    }

    // Not a project type we recognize
    return {};
  } catch (error) {
    // If we can't read the project.json, skip this project
    return {};
  }
}


/**
 * Create server project nodes for the project graph to add Nx targets and tags
 */
function createServerProjectNodes(projectRoot: string, projectJson: any) {
  const targets: Record<string, TargetConfiguration> = {};

  // Add Maven-based targets if they don't already exist
  if (!projectJson.targets?.build) {
    targets.build = {
      executor: 'nx:run-commands',
      options: {
        command: 'mvn clean package',
        cwd: projectRoot,
      },
    };
  }

  if (!projectJson.targets?.test) {
    targets.test = {
      executor: 'nx:run-commands',
      options: {
        command: 'mvn test',
        cwd: projectRoot,
      },
    };
  }

  if (!projectJson.targets?.serve) {
    targets.serve = {
      executor: 'nx:run-commands',
      options: {
        command: 'mvn spring-boot:run',
        cwd: projectRoot,
      },
    };
  }

  // Add missing tags
  const tags: string[] = projectJson.tags || [];
  if (!tags.includes('fhir')) {
    tags.push('fhir');
  }
  if (!tags.includes('server')) {
    tags.push('server');
  }
  if (!tags.includes('nx-fhir-server')) {
    tags.push('nx-fhir-server');
  }

  return {
    projects: {
      [projectRoot]: {
        targets,
        tags,
      },
    },
  };
}


/**
 * Create frontend project nodes for the project graph to add Nx targets and tags
 */
function createFrontendProjectNodes(projectRoot: string, projectJson: any) {
  // Enhance the project configuration
  const targets: Record<string, TargetConfiguration> = {};

  // Add frontend build target if it doesn't already exist
  if (!projectJson.targets?.build) {
    targets.build = {
      executor: 'nx:run-commands',
      options: {
        command: 'npm run build',
        cwd: projectRoot,
      },
    };
  }

  if (!projectJson.targets?.test) {
    targets.test = {
      executor: 'nx:run-commands',
      options: {
        command: 'npm test',
        cwd: projectRoot,
      },
    };
  }

  if (!projectJson.targets?.serve) {
    targets.serve = {
      executor: 'nx:run-commands',
      options: {
        command: 'npm run dev',
        cwd: projectRoot,
      },
    };
  }

  // Add missing tags
  const tags: string[] = projectJson.tags || [];
  if (!tags.includes('fhir')) {
    tags.push('fhir');
  }
  if (!tags.includes('frontend')) {
    tags.push('frontend');
  }
  if (!tags.includes('nx-fhir-frontend')) {
    tags.push('nx-fhir-frontend');
  }

  return {
    projects: {
      [projectRoot]: {
        targets,
        tags,
      },
    },
  };

}
