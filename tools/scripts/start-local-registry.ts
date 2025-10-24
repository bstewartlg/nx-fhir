/**
 * This script sets up a local registry for e2e testing purposes in Vitest's globalSetup.
 */

import { releasePublish, releaseVersion } from 'nx/release';
import { spawn } from 'child_process';

export default async function globalSetup() {
  // Local registry target to run
  const localRegistryTarget = '@nx-fhir/source:local-registry';

  // Start the local registry using nx run
  const registryProcess = spawn('npx', ['nx', 'run', localRegistryTarget], {
    stdio: 'inherit',
    shell: true,
    env: process.env
  });

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
    if (registryProcess) {
      registryProcess.kill();
    }
  };
}
