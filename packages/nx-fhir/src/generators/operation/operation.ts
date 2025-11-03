import {
  formatFiles,
  generateFiles,
  getProjects,
  Tree,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';
import { input } from '@inquirer/prompts';
import * as path from 'path';
import camelcase from 'camelcase';
import { OperationGeneratorSchema } from './schema';
import { ServerProjectConfiguration } from '../../shared/models';
import { getEmptyHapiOperation, getHapiOperation } from './lib';
import { OperationDefinition } from 'fhir/r5';
import { promptForServerProject } from '../../shared/utils';


/**
 * Prompt the user for a canonical URL for the operation definition.
 */
async function promptForDefinition(): Promise<string> {
  return (await input({
    message: '(optional) Enter the location of a FHIR OperationDefinition to use. This can be a URL or local file path to a JSON file or official canonical URL:',
  })).trim();
}

async function promptForOperationName(): Promise<string> {
  return (await input({
    message: 'What name would you like to use for the operation?',
    required: true,
  })).trim();
}

async function getDefinitionFromLocation(location: string): Promise<string> {
  try {

    // Check if the location is a URL or a local file path
    if (location.startsWith('http://') || location.startsWith('https://')) {
      
      // If it doesn't end with .json, we assume it's a canonical URL
      if (!location.endsWith('.json')) {
        // Replace the last '/' with '-' and append '.json'
        location = location.replace(new RegExp('/([^/]+)$'), '-$1.json');
      }

      const response = await fetch(location);
      if (!response.ok) {
        throw new Error(`Failed to fetch definition from ${location}: ${response.statusText}`);
      }
      return await response.text();
    } else {
      const fs = require('fs');
      if (!fs.existsSync(location)) {
        throw new Error(`Local definition file does not exist: ${location}`);
      }
      return fs.readFileSync(location, 'utf-8');
    }
  } catch (error) {
    logger.error(`Error fetching definition from ${location}: ${error.message}`);
    throw error;
  }
}


/**
 * Extract the name from the operation definition.
 * @param operationDefinition The operation definition JSON content as a string.
 * @returns The extracted name or an empty string if not found.
 */
function extractNameFromDefinition(definition: OperationDefinition): string {

  let name: string;

  if (definition.name) {
    name = definition.name;
  } else if (definition.code) {
    name = definition.code;
  }
  if (!name) {
    throw new Error('No name found in the OperationDefinition.');
  }

  return name;
}



/**
 * Generates a FHIR operation provider.
 */
export async function operationGenerator(
  tree: Tree,
  options: OperationGeneratorSchema
) {

  // Determine the server project to add the operation to
  const selectedServerProject = options.project ?? (await promptForServerProject(tree));

  const serverProjectConfig = readProjectConfiguration(tree, selectedServerProject) as ServerProjectConfiguration;
  
  if (!serverProjectConfig) {
    throw new Error(`Server project '${selectedServerProject}' not found.`);
  }

  let operationName = options.name;
  let definitionString: string;
  let operationDefinition: OperationDefinition;

  // If operation definition content is provided, use it directly
  if (options.defContent) {
    definitionString = options.defContent;
  }
  // Otherwise if a location is provided, attempt to get the definition content from there
  else if (options.defLocation) {
    definitionString = await getDefinitionFromLocation(options.defLocation);
  }
  // Otherwise prompt for a definition location
  else {
    options.defLocation = await promptForDefinition();
    if (options.defLocation) {
      definitionString = await getDefinitionFromLocation(options.defLocation);
    }
  }

  // If a name is provided we are going to use that, otherwise try to extract it from the definition
  if (!operationName) {

    // We have a definition string, try to parse it and extract the name from it
    if (definitionString) {
      operationDefinition = JSON.parse(definitionString);
      if (operationDefinition.resourceType !== 'OperationDefinition') {
        throw new Error('Provided definition is not a valid OperationDefinition resource.');
      }
      operationName = await extractNameFromDefinition(operationDefinition);
    }

    // still no operation name (shouldn't happen if the definition is valid)
    if (!operationName) {
      operationName = await promptForOperationName();
    }
  }

  // Should have a name by now, but just in case...
  if (!operationName) {
    throw new Error('Operation name could not be determined. Please provide a valid OperationDefinition or specify a name.');
  }

  operationName = camelcase(operationName, { pascalCase: true });
  
  
  logger.info(`Adding operation '${operationName}' to server project '${selectedServerProject}'`);

  // Find the Java source directory in the server project
  const javaSourcePath = path.join(serverProjectConfig.root, 'src', 'main', 'java');

  if (!tree.exists(javaSourcePath)) {
    throw new Error(`Java source directory '${javaSourcePath}' does not exist in project '${selectedServerProject}'.`);
  }

  let directory = options.directory;
  if (!directory) {
    directory = await input({
      message: 'Enter the path (relative from src/main/java root) where the operation should be created:',
      default: serverProjectConfig.packageBase ? path.join(serverProjectConfig.packageBase.replace(/\./g, '/'), 'providers') : 'providers',
      required: true,
    });
  }

  const targetPath = path.join(javaSourcePath, directory);
  const targetPackage = directory
    .replace(/[\\/]+/g, '.')     // replace both forward and back slashes with dots
    .replace(/^\.+|\.+$/g, '')   // trim leading/trailing dots
    .replace(/\.+/g, '.');       // collapse multiple dots
  const hapiOperation = operationDefinition ? getHapiOperation(operationDefinition, targetPackage, serverProjectConfig.fhirVersion) : getEmptyHapiOperation(operationName, targetPackage);
  logger.info(`Generating operation class: ${hapiOperation.className}`);


  generateFiles(
    tree,
    path.join(__dirname, 'files'),
    targetPath,
    {
      ...options,
      packageBase: serverProjectConfig.packageBase,
      operation: hapiOperation,
      operationClassName: hapiOperation.className,
    }
  );
  
  await formatFiles(tree);
}

export default operationGenerator;
