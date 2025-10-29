/**
 * This script sets up a local registry for e2e testing purposes in Vitest's globalSetup.
 */

import { releasePublish, releaseVersion } from 'nx/release';
import { spawn } from 'child_process';

export default async function globalSetup() {
  // Local registry target to run
  const localRegistryTarget = '@nx-fhir/source:local-registry';

  // Start the local registry using nx run
  // Use detached: true to create a new process group for proper cleanup
  const registryProcess = spawn('npx', ['nx', 'run', localRegistryTarget], {
    stdio: 'inherit',
    shell: true,
    env: process.env,
    detached: true,
  });

  // Unref so the parent process can exit independently
  registryProcess.unref();

  // Wait for the registry to be ready (simple delay, replace with health check if needed)
  await new Promise((resolve) => setTimeout(resolve, 3000));

  await releaseVersion({
    specifier: '0.0.0-e2e',
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
