import {
  addProjectConfiguration,
  formatFiles,
  Tree,
  logger,
} from '@nx/devkit';
import * as path from 'path';
import { ServerGeneratorSchema } from './schema';
import axios from 'axios';
import * as unzipper from 'unzipper';

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
  const { Select } = require('enquirer');
  const prompt = new Select({
    name: 'release',
    message: 'Select a HAPI FHIR JPA Starter release',
    choices: releases,
  });
  return prompt.run();
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

export async function serverGenerator(
  tree: Tree,
  options: ServerGeneratorSchema
) {
  const release =
    options.release ?? (await promptForRelease(await getHapiFhirReleases()));

  const projectName = path.basename(options.directory);

  addProjectConfiguration(tree, projectName, {
    root: options.directory,
    projectType: 'application',
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
  });

  await downloadAndExtract(tree, release, options.directory);

  await formatFiles(tree);
}

export default serverGenerator;
