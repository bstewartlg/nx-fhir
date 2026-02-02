// vitest-environment node
import { logger, workspaceRoot } from '@nx/devkit';
import { ServerGeneratorSchema } from '../../../packages/nx-fhir/src/generators/server/schema';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { execSync, spawn } from 'child_process';
import { FhirVersion } from '../../../packages/nx-fhir/src/shared/models';
import { hostname, networkInterfaces, tmpdir } from 'os';
import { getExecuteCommand, getInstallCommand, getPackageManager, getPackCommand } from '../../../packages/nx-fhir/src/shared/utils/package-manager';

const pluginVersion = require('../../../packages/nx-fhir/package.json').version;
const projectName = `test-project-${crypto.randomUUID()}`;
const projectDirectory = join(tmpdir(), projectName);
const nxFhirBuildPath = join(workspaceRoot, 'dist/packages/nx-fhir');
const nxFhirPackPath = join(nxFhirBuildPath, `nx-fhir-${pluginVersion}.tgz`);

const packageManager = getPackageManager();

describe('server generator e2e test', () => {
  const options: ServerGeneratorSchema = {
    directory: 'server',
    packageBase: 'org.custom.server',
    release: '8.6.0-1',
    fhirVersion: FhirVersion.R4,
  };

  beforeAll(async () => {
    logger.info(`Running server e2e test with package manager: ${packageManager}`);
    logger.info(`Creating test project directory. CWD: ${process.cwd()}`);
    logger.info(`Workspace root: ${workspaceRoot}`);
    logger.info(`Local hostname: ${hostname()}`);
    logger.info(`Network interfaces: ${JSON.stringify(networkInterfaces())}`);

    // Build the nx-fhir package
    logger.info(`Building nx-fhir package using command: ${getExecuteCommand(packageManager, 'nx build nx-fhir')}`);
    execSync(getExecuteCommand(packageManager, 'nx build nx-fhir'), {
      stdio: 'inherit',
      cwd: workspaceRoot,
      env: process.env
    });

    // Pack the nx-fhir package
    const packCommand = getPackCommand(packageManager);
    logger.info(`Packing nx-fhir package: ${packCommand}`);
    execSync(packCommand, {
      cwd: nxFhirBuildPath,
      stdio: 'inherit',
      env: process.env
    });

    expect(existsSync(nxFhirPackPath)).toBe(true);
    logger.info(`Built package located at: ${nxFhirPackPath}`);
  }, 300000);

  afterAll(async () => {
    // Cleanup test project
    try {
      rmSync(projectDirectory, { recursive: true, force: true });
      logger.info(`Cleaned up test project directory: ${projectDirectory}`);
    } catch (e) {
      // Ignore
    }
  });

  it('should complete full e2e flow: create workspace -> link local package -> generate server -> start and query', async () => {
    // Create a new Nx workspace
    logger.info('Creating new Nx workspace...');
    createTestProject();

    // Install nx-fhir as a dev dependency
    const installCommand = getInstallCommand(packageManager, nxFhirPackPath, true);
    logger.info(`Installing nx-fhir package into test workspace: ${installCommand}`);
    execSync(installCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: process.env
    });

    // Generate a FHIR server
    const generateCommand = getExecuteCommand(packageManager, `nx generate nx-fhir:server --directory=${options.directory} --packageBase=${options.packageBase} --release=${options.release}`);
    logger.info(`Operating in project directory: ${projectDirectory}`);
    logger.info(`Generating FHIR server: ${generateCommand}`);
    execSync(generateCommand, {
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

    // Start the server
    logger.info('Starting the generated server...');
    const serverProcess = spawn(getExecuteCommand(packageManager), ['nx', 'serve', 'server'], {
      cwd: projectDirectory,
    });

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

    // Query the /fhir/metadata endpoint
    logger.info('Querying /fhir/metadata endpoint...');
    const response = await fetch('http://localhost:8080/fhir/metadata');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toBeTruthy();
    expect(data.resourceType).toBe('CapabilityStatement');

    // Cleanup server process
    if (serverProcess.pid) {
      try {
        if (process.platform === 'win32') {
          // Use taskkill on Windows to terminate the process tree
          execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
        } else {
          // On Unix-like systems, send SIGTERM and wait, then force kill if needed
          serverProcess.kill('SIGTERM');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            serverProcess.kill('SIGKILL');
          } catch (e) {
            // Ignore
          }
        }
      } catch (err) {
        logger.warn(`Failed to cleanly kill server process: ${err}`);
      }
    }
  }, 300000);
});

function createTestProject() {
  logger.info(`Creating project directory at: ${projectDirectory} -- ${dirname(projectDirectory)}`);
  rmSync(projectDirectory, { recursive: true, force: true });
  mkdirSync(dirname(projectDirectory), { recursive: true });

  execSync(getExecuteCommand(packageManager, `create-nx-workspace@latest ${projectName} --preset apps --nxCloud=skip --no-interactive --skip-git`), {
    cwd: dirname(projectDirectory),
    stdio: 'inherit',
    env: process.env
  });
  logger.info(`Created test project at ${projectDirectory}`);
}
