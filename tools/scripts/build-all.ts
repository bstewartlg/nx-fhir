/**
 * Vitest globalSetup to build all projects before running tests.
 */
import { logger } from '@nx/devkit';
import { exec } from 'child_process';

export default async function globalSetup() {
  await new Promise<void>((resolve, reject) => {
    exec('npx nx run-many -t build', (error, stdout, stderr) => {
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