// vitest-environment node
import { logger } from '@nx/devkit';
import { ServerGeneratorSchema } from './schema';
import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { execSync, spawn } from 'child_process';
import { FhirVersion } from '../../shared/models';
import { tmpdir } from 'os';
import { getExecuteCommand, getInstallCommand, getListCommand, getPackageManager } from '../../shared/utils/package-manager';
import { releasePublish, releaseVersion } from 'nx/release';

const projectName = `test-project-${crypto.randomUUID()}`;
const projectDirectory = join(tmpdir(), projectName);
const localRegistryUrl = 'http://localhost:4873';

const packageManager = getPackageManager();

describe('server generator e2e test', () => {
  const options: ServerGeneratorSchema = {
    directory: 'server',
    packageBase: 'org.custom.server',
    release: '8.4.0',
    fhirVersion: FhirVersion.R4,
  };

  let registryProcess: any;

  beforeAll(async () => {
    logger.info(`Running server e2e test with package manager: ${packageManager}`);
    logger.info(`Creating test project directory. CWD: ${process.cwd()}`);

    // Step 1: Build the nx-fhir package
    logger.info('Building nx-fhir package...');
    execSync(getExecuteCommand(packageManager, 'nx build nx-fhir'), {
      stdio: 'inherit',
      env: process.env
    });

    // Step 2: Start local registry
    logger.info('Starting local registry...');
    registryProcess = spawn(getExecuteCommand(packageManager), ['nx', 'run', '@nx-fhir/source:local-registry'], {
      stdio: 'ignore',
      shell: true,
      env: process.env,
      detached: true,
    });
    registryProcess.unref();

    // Wait for registry to be ready
    await waitForRegistry();

    // Step 3: Publish nx-fhir to local registry
    logger.info('Publishing nx-fhir to local registry...');
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
      registry: localRegistryUrl
    });

  }, 300000);

  afterAll(async () => {
    // Cleanup registry process
    if (registryProcess && registryProcess.pid) {
      try {
        process.kill(-registryProcess.pid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          process.kill(-registryProcess.pid, 'SIGKILL');
        } catch (e) {
          // Process already terminated
        }
      } catch (err) {
        try {
          registryProcess.kill('SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          registryProcess.kill('SIGKILL');
        } catch (e) {
          // Ignore
        }
      }
    }

    // Cleanup test project
    try {
      rmSync(projectDirectory, { recursive: true, force: true });
      logger.info(`Cleaned up test project directory: ${projectDirectory}`);
    } catch (e) {
      // Ignore
    }
  });

  it('should complete full e2e flow: build -> publish -> create workspace -> generate server -> start and query', async () => {
    // Step 4: Create a new Nx workspace
    logger.info('Creating new Nx workspace...');
    createTestProject();

    // Step 5: Add nx-fhir as a dev dependency from local registry
    logger.info('Installing nx-fhir@e2e from local registry...');
    const installCommand = `${getInstallCommand(packageManager, 'nx-fhir@e2e', true)} --registry=${localRegistryUrl}`;
    execSync(installCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: process.env
    });

    // Verify package is installed
    const listCommand = getListCommand(packageManager, 'nx-fhir');
    execSync(listCommand, {
      cwd: projectDirectory,
      stdio: 'inherit'
    });

    // Step 6: Generate a FHIR server
    logger.info('Generating FHIR server...');
    execSync(getExecuteCommand(packageManager, `nx generate nx-fhir:server --directory=${options.directory} --packageBase=${options.packageBase} --release=${options.release}`), {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: process.env
    });

    // Verify generated files exist
    const expectedFiles = [
      'server/src/main/resources/application.yaml',
      'server/src/main/java/ca/uhn/fhir/jpa/starter/AppProperties.java',
      'server/.gitignore',
      'server/Dockerfile',
      'server/pom.xml',
    ];
    expectedFiles.forEach(file => {
      const filePath = join(projectDirectory, file);
      expect(filePath).toBeTruthy();
      expect(existsSync(filePath)).toBe(true);
    });

    // Verify server project in workspace
    execSync(getExecuteCommand(packageManager, 'nx reset'), {
      cwd: projectDirectory,
      env: process.env
    });
    const result = execSync(getExecuteCommand(packageManager, 'nx show projects'), {
      cwd: projectDirectory,
      env: process.env
    }).toString();
    expect(result).toContain('server');

    // Step 7: Start the server
    logger.info('Starting the generated server...');
    const serverProcess = spawn(getExecuteCommand(packageManager), ['nx', 'serve', 'server'], {
      cwd: projectDirectory,
      shell: true,
      detached: true,
    });
    serverProcess.unref();

    let output = '';
    let serverStarted = false;

    // Wait for server to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server failed to start within timeout'));
      }, 120000);

      serverProcess.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        if (chunk.includes('Started Application in') && !serverStarted) {
          serverStarted = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess.on('close', (code) => {
        if (code !== 0 && !serverStarted) {
          clearTimeout(timeout);
          reject(new Error(`Process exited with code ${code}\n${output}`));
        }
      });
    });

    // Step 8: Query the /fhir/metadata endpoint
    logger.info('Querying /fhir/metadata endpoint...');
    const response = await fetch('http://localhost:8080/fhir/metadata');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toBeTruthy();
    expect(data.resourceType).toBe('CapabilityStatement');

    // Cleanup server process
    if (serverProcess.pid) {
      try {
        process.kill(-serverProcess.pid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          process.kill(-serverProcess.pid, 'SIGKILL');
        } catch (e) {
          // Ignore
        }
      } catch (err) {
        try {
          serverProcess.kill('SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          serverProcess.kill('SIGKILL');
        } catch (e) {
          // Ignore
        }
      }
    }
  }, 300000);
});

async function waitForRegistry() {
  const urlsToTry = [localRegistryUrl, 'http://127.0.0.1:4873'];
  let registryReady = false;
  let maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    for (const url of urlsToTry) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        });
        if (response.status) {
          registryReady = true;
          logger.info(`Local registry is ready at ${url}`);
          break;
        }
      } catch (error) {
        // Continue
      }
    }
    if (registryReady) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!registryReady) {
    throw new Error(`Local registry failed to start within ${maxAttempts} seconds`);
  }
}

function createTestProject() {
  rmSync(projectDirectory, { recursive: true, force: true });
  mkdirSync(dirname(projectDirectory), { recursive: true });

  // Create .npmrc to use local registry
  const npmrcPath = join(dirname(projectDirectory), '.npmrc');
  writeFileSync(npmrcPath, `registry=${localRegistryUrl}\n`);

  try {
    execSync(getExecuteCommand(packageManager, `create-nx-workspace@latest ${projectName} --preset apps --nxCloud=skip --no-interactive --skip-git`), {
      cwd: dirname(projectDirectory),
      stdio: 'inherit',
      env: process.env
    });
    logger.info(`Created test project at ${projectDirectory}`);
  } finally {
    try {
      unlinkSync(npmrcPath);
    } catch (e) {
      // Ignore
    }
  }
}


