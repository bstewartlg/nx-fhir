/**
 * Vitest globalSetup to build all projects before running tests.
 */
import { logger } from '@nx/devkit';
import { exec } from 'child_process';
import { getExecuteCommand, getPackageManager } from '../../packages/nx-fhir/src/shared/utils/package-manager';

export default async function globalSetup() {
  const packageManager = getPackageManager();
  logger.info(`Building all projects using package manager: ${packageManager}`);
  await new Promise<void>((resolve, reject) => {
    exec(getExecuteCommand(packageManager,'nx run-many -t build'), (error, stdout, stderr) => {
      if (error) {
        logger.error(`Build failed: ${stderr}`);
        reject(error);
      } else {
        logger.info(`Build output: ${stdout}`);
        resolve();
      }
    });
  });
}