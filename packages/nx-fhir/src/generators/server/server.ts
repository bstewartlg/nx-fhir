import {
  addProjectConfiguration,
  formatFiles,
  Tree,
  logger,
  generateFiles,
} from '@nx/devkit';
import * as path from 'path';
import { ServerGeneratorSchema } from './schema';
import axios from 'axios';
import * as unzipper from 'unzipper';
import { ServerProjectConfiguration } from '../../shared/models';
import { select } from '@inquirer/prompts';

async function getHapiFhirReleases(): Promise<string[]> {
  try {
    const response = await axios.get(
      'https://api.github.com/repos/hapifhir/hapi-fhir-jpaserver-starter/releases'
    );
    const tags = response.data.map((tag: { name: string }) => tag.name);
    return tags.filter((tag: string) => tag.startsWith('image/'));
  } catch (error) {
    logger.error('Failed to fetch HAPI FHIR releases.');
    throw error;
  }
}

async function promptForRelease(releases: string[]): Promise<string> {
  return await select({
    message: 'Select a HAPI FHIR JPA Starter release',
    choices: releases,
  });
}

async function downloadAndExtract(
  tree: Tree,
  release: string,
  directory: string
) {
  const url = `https://github.com/hapifhir/hapi-fhir-jpaserver-starter/archive/refs/tags/${release}.zip`;
  logger.info(`Downloading from ${url}`);
  try {
    const response = await axios.get(url, { responseType: 'stream' });

    const stream = response.data.pipe(
      unzipper.Parse({ forceStream: true })
    );

    for await (const entry of stream) {
      const fileName = entry.path.split('/').slice(1).join('/'); // remove root dir
      if (
        fileName.startsWith('src/') ||
        fileName === '.gitignore' ||
        fileName === 'Dockerfile' ||
        fileName === 'pom.xml'
      ) {
        const filePath = path.join(directory, fileName);
        if (entry.type !== 'Directory') {
          const content = await entry.buffer();
          tree.write(filePath, content);
        }
      } else {
        entry.autodrain();
      }
    }
  } catch (error) {
    logger.error(`Failed to download or extract ${url}`);
    throw error;
  }
}


/**
 * Generates files that will sit alongside the downloaded and extracted HAPI FHIR JPA Starter files.
 */
function createHapiFiles(
  tree: Tree,
  directory: string,
  packageBase: string
) {
  
  logger.info(`Creating HAPI files in ${directory}`);

  // Generate the Application.java file in the correct package directory
  generateFiles(
    tree,
    path.join(__dirname, 'files', 'hapi-starter'),
    directory,
    {
      packageBase,
    }
  );
}

/**
 * Generates the custom Java files in the custom package directory in the src/main/java directory.
 */
function createCustomSourceFiles(
  tree: Tree,
  directory: string,
  packageBase: string
) {
  // Convert package path to directory structure (e.g., "org.custom.server" -> "src/main/java/org/custom/server")
  const packageDir = packageBase.replace(/\./g, '/');
  const javaSourceDir = path.join(directory, 'src', 'main', 'java', packageDir);
  
  // Generate all custom source files from the files directory structure
  generateFiles(
    tree,
    path.join(__dirname, 'files', 'custom'),
    javaSourceDir,
    {
      packageBase,
    }
  );
}


/**
 * Main server generator entry point.
 */
export async function serverGenerator(
  tree: Tree,
  options: ServerGeneratorSchema
) {
  const release =
    options.release ?? (await promptForRelease(await getHapiFhirReleases()));

  logger.info(`Using HAPI JPA starter release: ${release}`);

  const projectName = path.basename(options.directory || 'server');

  const projectConfiguration: ServerProjectConfiguration = {
    root: options.directory,
    projectType: 'application',
    sourceRoot: `${options.directory}/src`,
    targets: {
      serve: {
        executor: 'nx:run-commands',
        options: {
          command: 'mvn spring-boot:run',
          cwd: options.directory,
        },
      },
      start: {
        executor: 'nx:run-commands',
        options: {
          command: 'mvn spring-boot:run',
          cwd: options.directory,
        },
      },
    },
    tags: ['fhir', 'server'],
    packageBase: options.packageBase,
    fhirVersion: options.fhirVersion,
  };
  addProjectConfiguration(tree, projectName, projectConfiguration);

  await downloadAndExtract(tree, release, options.directory);
  createHapiFiles(tree, options.directory, options.packageBase);
  createCustomSourceFiles(tree, options.directory, options.packageBase);

  await formatFiles(tree);
}

export default serverGenerator;
