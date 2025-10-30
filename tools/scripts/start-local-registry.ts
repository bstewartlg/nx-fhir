/**
 * This script sets up a local registry for e2e testing purposes in Vitest's globalSetup.
 */

import { releasePublish, releaseVersion } from 'nx/release';
import { spawn } from 'child_process';
import { logger } from '@nx/devkit';
import * as http from 'http';

/**
 * Check if the registry is available using http.get
 */
function checkRegistryWithHttp(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, (res) => {
      // Any response means the server is up
      resolve(res.statusCode !== undefined);
      res.resume(); // Consume response data to free up memory
    });
    
    request.on('error', () => {
      resolve(false);
    });
    
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

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
  
  // Detect CI environment
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

  // Start the local registry using nx run
  // In CI environments, don't use detached mode to ensure proper process management
  const registryProcess = spawn(pmx, ['nx', 'run', localRegistryTarget], {
    stdio: isCI ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    shell: true,
    env: process.env,
    detached: !isCI, // Only detach in local environments
  });

  // Only unref if detached
  if (!isCI) {
    registryProcess.unref();
  }

  // In CI, log output for debugging
  if (isCI && registryProcess.stdout && registryProcess.stderr) {
    registryProcess.stdout.on('data', (data) => {
      logger.info(`[Verdaccio] ${data.toString().trim()}`);
    });
    registryProcess.stderr.on('data', (data) => {
      logger.warn(`[Verdaccio Error] ${data.toString().trim()}`);
    });
  }

  // Add a longer initial delay in CI to allow the process to fully start
  const initialDelay = isCI ? 5000 : 2000;
  await new Promise((resolve) => setTimeout(resolve, initialDelay));

  // Verify the process started
  try {
    if (registryProcess.exitCode !== null) {
      throw new Error(`Registry process exited immediately with code ${registryProcess.exitCode}`);
    }
  } catch (e) {
    logger.error(`Failed to start registry process: ${e}`);
    throw e;
  }

  // Wait for the registry to be ready with retries
  logger.info('Waiting for local registry to start...');
  let registryReady = false;
  let maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Use http.get instead of fetch for better compatibility in containers
      const isUp = await checkRegistryWithHttp(registryUrl);
      if (isUp) {
        registryReady = true;
        logger.info('Local registry is ready');
        break;
      }
      logger.warn(`Local registry not ready yet, retrying in 1 second... (${i + 1}/${maxAttempts})`);
    } catch (error) {
      logger.warn(`Local registry check failed (${(error as Error).message}), retrying in 1 second... (${i + 1}/${maxAttempts})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!registryReady) {
    // Log more diagnostic info before failing
    logger.error('Local registry failed to start. Verdaccio process output captured above.');
    logger.error(`Attempted to connect to: ${registryUrl}`);
    logger.error(`CI environment: ${isCI}`);
    throw new Error(`Local registry failed to start within ${maxAttempts} seconds`);
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
        if (isCI) {
          // In CI, just kill the process normally
          registryProcess.kill('SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          try {
            registryProcess.kill('SIGKILL');
          } catch (e) {
            // Process already terminated, ignore
          }
        } else {
          // In local environments, kill the entire process group
          process.kill(-registryProcess.pid, 'SIGTERM');

          // Give it a moment to clean up gracefully
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Force kill if still running
          try {
            process.kill(-registryProcess.pid, 'SIGKILL');
          } catch (e) {
            // Process already terminated, ignore
          }
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
