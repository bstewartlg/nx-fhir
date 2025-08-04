import {
  getProjects,
  logger,
  ProjectConfiguration,
  Tree,
} from '@nx/devkit';
import * as path from 'path';
import { ImplementationGuideGeneratorSchema } from './schema';
import { ImplementationGuideHapiConfig, ImplementationGuidePackage, ServerProjectConfiguration } from '../../shared/models';
import { updateServerYaml } from '../../shared/utils';
import operationGenerator from '../operation/operation';
import { readFileSync } from 'fs';
import * as tar from 'tar';
import { OperationGeneratorSchema } from '../operation/schema';
import { prompt } from 'enquirer';



/**
 * Write changes with the new/updated package to the server config YAML.
 */
function writeConfigChanges(project: ProjectConfiguration, tree: Tree, options: ImplementationGuideGeneratorSchema) {

  const newPackage: ImplementationGuideHapiConfig = {
    name: options.id,
    version: options.igVersion,
    installMode: options.install ? 'STORE_AND_INSTALL' : 'STORE_ONLY',
  };
  if (options.package) {
    newPackage.packageUrl = options.package;
  }
  const key = newPackage.name.toLowerCase().replace(/[^a-z0-9]+/g, '');

  updateServerYaml(project.root, tree, `hapi.fhir.implementationguides.${key}`, newPackage);
}

async function parsePackage(packagePath: string): Promise<ImplementationGuidePackage> {
  
  // Parse the package tgz for its ID, version, and any OperationDefinitions
  const igPackage: ImplementationGuidePackage = {
    implementationGuide: null,
    capabilityStatements: [],
    operations: [],
  };
  let tgzFile;

  // Fetch the package from the provided location (URL or local path)
  if (packagePath.startsWith('http://') || packagePath.startsWith('https://')) {
    // Fetch the package from the URL
    const response = await fetch(packagePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch package from ${packagePath}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    tgzFile = Buffer.from(arrayBuffer);
    
  } else {
    // Read the package from the local file system
    tgzFile = readFileSync(packagePath);
  }
  
  tar.t({
    sync: true,
    onentry: entry => {
      // logger.info(`Found entry: ${entry.path}`);
      if (entry.path.startsWith('package/ImplementationGuide-') && entry.path.endsWith('.json')) {
        let content = '';
        entry.on('data', (chunk) => {
          content += chunk.toString();
        });
        entry.on('end', () => {
          igPackage.implementationGuide = JSON.parse(content);
        });
      } else if (entry.path.startsWith('package/OperationDefinition-') && entry.path.endsWith('.json')) {
        let content = '';
        entry.on('data', (chunk) => {
          content += chunk.toString();
        });
        entry.on('end', () => {
          igPackage.operations.push(JSON.parse(content));
        });
      } else if (entry.path.startsWith('package/CapabilityStatement-') && entry.path.endsWith('.json')) {
        let content = '';
        entry.on('data', (chunk) => {
          content += chunk.toString();
        });
        entry.on('end', () => {
          igPackage.capabilityStatements.push(JSON.parse(content));
        });
      }
    }
  }).end(tgzFile);

  if (igPackage.operations.length > 0) {
    logger.info(`Found ${igPackage.operations.length} OperationDefinition${igPackage.operations.length > 1 ? 's' : ''} in package: ${igPackage.operations.map(op => op.id).join(', ')}`);
  }
  if (igPackage.capabilityStatements.length > 0) {
    logger.info(`Found ${igPackage.capabilityStatements.length} CapabilityStatement${igPackage.capabilityStatements.length > 1 ? 's' : ''} in package: ${igPackage.capabilityStatements.map(cs => cs.id).join(', ')}`);
  }
  
  return igPackage;

}


/**
 * Main implementation guide generator entry point.
 */
export async function implementationGuideGenerator(
  tree: Tree,
  options: ImplementationGuideGeneratorSchema
) {

  if (!options.project) {
    throw new Error('Project is required for implementation guide generation.');
  }

  const projects = getProjects(tree);
  const serverProjectConfig = projects.get(options.project) as ServerProjectConfiguration;

  let parsedPackage: ImplementationGuidePackage;

  logger.info(`options check: ${ options.project && options.id && options.igVersion }`);

  // Project and package provided, so we will attempt to fetch the package to obtain the ID and version
  if (options.project && options.package) {
    logger.info(
      `Updating project: ${options.project} with implementation guide package: ${options.package}`
    );

    parsedPackage = await parsePackage(options.package);
  }

  // If all options are provided we will just trust them and write the changes
  else if (options.project && options.id && options.igVersion) {
    logger.info(
      `Updating project: ${options.project} with provided implementation guide ID: ${options.id} and version: ${options.igVersion}`
    );

    const projectConfig = getProjects(tree).get(options.project);
    if (!projectConfig) {
      throw new Error(`Project "${options.project}" not found in workspace.`);
    }

    writeConfigChanges(projectConfig, tree, options);

    // If not skipping operations, we will try and fetch the package from the public FHIR registry
    if (!options.skipOps) {
      try {
        parsedPackage = await parsePackage(`https://packages.fhir.org/${options.id}/${options.igVersion}`);
      } catch (error) {
        // logger.error(`Could not fetch IG package`);
        logger.error(error.message);
      }
    }
  }


  // Prompt to generate operations if not skipping that
  if (!options.skipOps) {

    if (parsedPackage && parsedPackage.operations.length > 0) {
      // Call operations generator if we have operations to add
      logger.info(`Generating operations for implementation guide: ${options.id}`);
      for (const operation of parsedPackage.operations) {
        logger.info(`Generating operation: ${operation.name}`);

        if (!options.opDirectory) {
          const response = await prompt<{ directory: string }>({
            type: 'input',
            name: 'directory',
            message: 'Enter the path (relative from src/main/java root) where the operation should be created:',
            initial: serverProjectConfig.packageBase ? path.join(serverProjectConfig.packageBase.replace(/\./g, '/'), 'providers') : 'providers',
            validate: (value: string) => value && value.trim().length > 0 ? true : 'Directory is required',
          });
          options.opDirectory = response.directory;
        }


        const operationOptions: OperationGeneratorSchema = {
          project: options.project,
          defContent: JSON.stringify(operation),
          directory: options.opDirectory,
        }
        await operationGenerator(tree, operationOptions);
      }
    } else {
      logger.info('No operations to generate.');
    }

  } else {
    logger.info('Skipping operations generation as requested.');
  }

}

export default implementationGuideGenerator;
