/**
 * This script sets up a local registry for e2e testing purposes in Vitest's globalSetup.
 */

import { releasePublish, releaseVersion } from 'nx/release';
import { spawn } from 'child_process';
import { logger } from '@nx/devkit';

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
  logger.info(`Waiting ${initialDelay}ms for Verdaccio to initialize...`);
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
  
  // In CI, try to get network diagnostic info
  if (isCI) {
    try {
      const { execSync } = await import('child_process');
      logger.info('Network diagnostic - checking if port 4873 is listening:');
      const netstat = execSync('netstat -tuln | grep 4873 || ss -tuln | grep 4873 || echo "netstat/ss not available"').toString();
      logger.info(netstat);
    } catch (e) {
      logger.warn('Could not run network diagnostic');
    }
  }

  // Wait for the registry to be ready with retries
  logger.info('Waiting for local registry to start...');
  logger.info(`CI environment: ${isCI}, Registry URL: ${registryUrl}`);
  let registryReady = false;
  let maxAttempts = 60;
  let lastError: Error | null = null;
  
  // Try multiple addresses in case of container networking issues
  const urlsToTry = [
    registryUrl,
    'http://127.0.0.1:4873',
  ];
  
  for (let i = 0; i < maxAttempts; i++) {
    // Try each URL until one works
    for (const url of urlsToTry) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(2000), // 2 second timeout
        });
        // Any response (even error status) means the server is up
        if (response.status) {
          registryReady = true;
          logger.info(`Local registry is ready at ${url} (HTTP ${response.status})`);
          break;
        }
      } catch (error) {
        lastError = error as Error;
        // Continue to next URL
      }
    }
    
    if (registryReady) {
      break;
    }
    
    if (i === 0 || i % 10 === 0 || i === maxAttempts - 1) {
      // Log more detailed error every 10 attempts and on first/last attempt
      const errorDetails = lastError ? `${lastError.name}: ${lastError.message}` : 'Unknown error';
      logger.warn(`Attempt ${i + 1}/${maxAttempts} - Local registry not ready yet. Last error: ${errorDetails}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!registryReady) {
    // Log comprehensive diagnostic info before failing
    logger.error('❌ Local registry failed to start within timeout period.');
    logger.error('');
    logger.error('Diagnostic Information:');
    logger.error(`  • CI environment: ${isCI}`);
    logger.error(`  • Attempted URLs: ${urlsToTry.join(', ')}`);
    logger.error(`  • Max attempts: ${maxAttempts} (${maxAttempts} seconds total)`);
    logger.error(`  • Last error: ${lastError?.name || 'Unknown'} - ${lastError?.message || 'No error details'}`);
    logger.error('');
    logger.error('Possible causes:');
    logger.error('  1. Verdaccio process failed to start (check output above)');
    logger.error('  2. Port 4873 is already in use');
    logger.error('  3. Network/firewall blocking localhost connections');
    logger.error('  4. Container networking issue (check Verdaccio is listening on 0.0.0.0:4873)');
    logger.error('');
    logger.error('Verdaccio process output should be visible above this error.');
    
    throw new Error(
      `Local registry failed to start within ${maxAttempts} seconds. ` +
      `Last error: ${lastError?.message || 'Connection failed'}. ` +
      `Tried URLs: ${urlsToTry.join(', ')}`
    );
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
