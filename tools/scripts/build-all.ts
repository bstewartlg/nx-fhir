/**
 * Vitest globalSetup to build all projects before running tests.
 */
import { exec } from 'child_process';

export default async function globalSetup() {
  await new Promise<void>((resolve, reject) => {
    exec('npx nx run-many -t build', (error, stdout, stderr) => {
      if (error) {
        console.error('Build failed:', stderr);
        reject(error);
      } else {
        console.log('Build output:', stdout);
        resolve();
      }
    });
  });
}