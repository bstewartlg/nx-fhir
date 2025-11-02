import {
  addProjectConfiguration,
  formatFiles,
  Tree,
  logger,
  generateFiles,
} from '@nx/devkit';
import * as path from 'path';
import { ServerGeneratorSchema } from './schema';
import { Readable } from 'stream';
import * as unzipper from 'unzipper';
import { ServerProjectConfiguration } from '../../shared/models';
import { select } from '@inquirer/prompts';
import { registerNxPlugin, updateServerYaml } from '../../shared/utils';
import {
  HAPI_RELEASE_URLS,
  PLUGIN_VERSION,
  SUPPORTED_HAPI_VERSIONS,
} from '../../shared/constants/versions';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { getAllFiles } from '../../shared/utils/merge';

async function promptForRelease(releases: string[]): Promise<string> {
  return await select({
    message: 'Select a HAPI FHIR JPA Starter release',
    choices: releases,
  });
}

/**
 * Downloads and extracts the specified HAPI FHIR JPA Starter release to a temporary directory.
 */
export async function downloadAndExtract(release: string) {
  const tempDir = join(tmpdir(), `nx-fhir-server-${crypto.randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  const url = HAPI_RELEASE_URLS[release];
  logger.info(`Downloading from ${url}`);
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const nodeStream = Readable.fromWeb(response.body as any);
    const stream = nodeStream.pipe(unzipper.Parse({ forceStream: true }));

    for await (const entry of stream) {
      const fileName = entry.path.split('/').slice(1).join('/'); // remove root dir
      if (
        fileName.startsWith('src/') ||
        fileName === '.gitignore' ||
        fileName === 'Dockerfile' ||
        fileName === 'pom.xml'
      ) {
        const filePath = path.join(tempDir, fileName);
        if (entry.type === 'Directory') {
          mkdirSync(filePath, { recursive: true });
        } else {
          const content = await entry.buffer();
          writeFileSync(filePath, content);
        }
      } else {
        entry.autodrain();
      }
    }
  } catch (error) {
    logger.error(
      `Failed to download or extract ${url} -- ${error instanceof Error ? error.message : String(error)}`,
    );
    if (tempDir) {
      logger.info(`Cleaning up temporary directory ${tempDir}`);
      rmSync(tempDir, { recursive: true, force: true });
    }
    throw error;
  }

  logger.info(`Extracted HAPI FHIR JPA Starter v${release} to ${tempDir}`);
  return tempDir;
}

/**
 * Generates files that will sit alongside the downloaded and extracted HAPI FHIR JPA Starter files.
 */
export function createHapiFiles(
  tree: Tree,
  directory: string,
  packageBase: string,
) {
  logger.info(`Creating HAPI files in ${directory}`);

  // Generate the Application.java file in the correct package directory
  generateFiles(
    tree,
    path.join(__dirname, 'files', 'hapi-starter'),
    directory,
    {
      packageBase,
    },
  );
}

/**
 * Generates the custom Java files in the custom package directory in the src/main/java directory.
 */
export function createCustomSourceFiles(
  tree: Tree,
  directory: string,
  packageBase: string,
) {
  // Convert package path to directory structure (e.g., "org.custom.server" -> "src/main/java/org/custom/server")
  const packageDir = packageBase.replace(/\./g, '/');
  const javaSourceDir = path.join(directory, 'src', 'main', 'java', packageDir);

  // Generate all custom source files from the files directory structure
  generateFiles(tree, path.join(__dirname, 'files', 'custom'), javaSourceDir, {
    packageBase,
  });
}

/**
 * Main server generator entry point.
 */
export async function serverGenerator(
  tree: Tree,
  options: ServerGeneratorSchema,
) {
  const release =
    options.release ?? (await promptForRelease(SUPPORTED_HAPI_VERSIONS));
  if (!SUPPORTED_HAPI_VERSIONS.includes(release)) {
    throw new Error(`Unsupported HAPI version: ${release}`);
  }
  const isDryRun = process.argv.includes('--dry-run');

  logger.info(`Using HAPI JPA starter release: ${release}`);

  const projectName = path.basename(options.directory || 'server');

  const projectConfiguration: ServerProjectConfiguration = {
    root: options.directory,
    projectType: 'application',
    sourceRoot: `${options.directory}/src`,
    tags: ['nx-fhir-server', 'fhir', 'server'],
    packageBase: options.packageBase,
    fhirVersion: options.fhirVersion,
    hapiReleaseVersion: release,
    pluginVersion: PLUGIN_VERSION,
  };
  addProjectConfiguration(tree, projectName, projectConfiguration);

  if (isDryRun) {
    logger.info(
      'Dry-run mode enabled; skipping download and extraction of HAPI FHIR JPA Starter.',
    );
    tree.write(
      `${options.directory}/src/main/resources/application.yaml`,
      'hapi.fhir.fhir_version: ' + options.fhirVersion,
    );
  } else {
    let tempDir: string;

    try {
      // Download release to temporary directory
      tempDir = await downloadAndExtract(release);

      // Copy extracted files to the project directory
      logger.info(
        `Copying extracted files to project directory: ${options.directory}`,
      );
      const filesToCopy = getAllFiles(tempDir).map(filePath => path.join(tempDir, filePath));
      for (const filePath of filesToCopy) {
        const stats = statSync(filePath);
        if (!stats.isFile()) {
          continue;
        }
        tree.write(
          path.join(options.directory, filePath.replace(`${tempDir}`, '')),
          readFileSync(filePath),
        );
      }

      createHapiFiles(tree, options.directory, options.packageBase);
      createCustomSourceFiles(tree, options.directory, options.packageBase);

      updateServerYaml(
        projectConfiguration.root,
        tree,
        `hapi.fhir.fhir_version`,
        options.fhirVersion,
      );

      registerNxPlugin(tree);
    } catch (error) {
      logger.error(
        `Error during server generation: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    } finally {
      if (tempDir && !isDryRun) {
        logger.info(`Cleaning up temporary files in ${tempDir}`);
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  await formatFiles(tree);
}

export default serverGenerator;
