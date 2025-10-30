/**
 * This script sets up a local registry for e2e testing purposes in Vitest's globalSetup.
 */

import { releasePublish, releaseVersion } from 'nx/release';
import { spawn, execSync } from 'child_process';
import { logger } from '@nx/devkit';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

export default async function globalSetup() {
  // Local registry target to run
  const localRegistryTarget = '@nx-fhir/source:local-registry';
  const registryUrl = 'http://localhost:4873';
  const pm =
    process.env.PACKAGE_MANAGER === 'npm' ||
    process.env.PACKAGE_MANAGER === 'bun'
      ? process.env.PACKAGE_MANAGER
      : 'npm';
  const pmx = pm === 'bun' ? 'bunx' : 'npx';

  // Start the local registry using nx run
  // Use detached: true to create a new process group for proper cleanup
  const registryProcess = spawn(pmx, ['nx', 'run', localRegistryTarget], {
    stdio: 'inherit',
    shell: true,
    env: process.env,
    detached: true,
  });

  // Unref so the parent process can exit independently
  registryProcess.unref();

  // Wait for the registry to be ready with retries
  logger.info('Waiting for local registry to start...');
  let registryReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(registryUrl);
      registryReady = true;
      logger.info('Local registry is ready');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!registryReady) {
    throw new Error('Local registry failed to start within 30 seconds');
  }

  logger.info('Versioning packages...');
  await releaseVersion({
    specifier: '0.0.0-dev',
    stageChanges: false,
    gitCommit: false,
    gitTag: false,
    firstRelease: true,
    versionActionsOptionsOverrides: {
      skipLockFileUpdate: true,
    },
  });
  
  await releasePublish({
    tag: 'e2e',
    firstRelease: true,
    registry: registryUrl
  });

  return async () => {
    if (registryProcess && registryProcess.pid) {
      try {
        // Kill the entire process group to ensure all child processes are terminated
        // Negative PID kills the process group
        process.kill(-registryProcess.pid, 'SIGTERM');

        // Give it a moment to clean up gracefully
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Force kill if still running
        try {
          process.kill(-registryProcess.pid, 'SIGKILL');
        } catch (e) {
          // Process already terminated, ignore
        }
      } catch (err) {
        // If the process group doesn't exist or we can't signal it,
        // fall back to killing just the main process
        try {
          registryProcess.kill('SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          registryProcess.kill('SIGKILL');
        } catch (e) {
          // Process already terminated
        }
      }
    }
  };
}
