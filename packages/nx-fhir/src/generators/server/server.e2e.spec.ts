// vitest-environment node
import { detectPackageManager, logger, } from '@nx/devkit';
import { ServerGeneratorSchema } from './schema';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { FhirVersion } from '../../shared/models';
import { tmpdir } from 'os';
import { getExecuteCommand, getInstallCommand, getListCommand } from '../../shared/utils/package-manager';


const projectName = `test-project-${crypto.randomUUID()}`;
const projectDirectory = join(tmpdir(), projectName);


describe('server generator e2e test', () => {
  const options: ServerGeneratorSchema = {
    directory: 'server',
    packageBase: 'org.custom.server',
    release: '8.4.0',
    fhirVersion: FhirVersion.R4,
  };

  const packageManager = detectPackageManager();

  // Ensure the test project directory exists before running tests
  beforeAll(async () => {
    logger.info(`Creating test project directory. CWD: ${process.cwd()}`);
    createTestProject();

    logger.info(`Using package manager: ${packageManager}`);
    
    const installCommand = getInstallCommand(packageManager, 'nx-fhir@e2e', true);
    execSync(installCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: process.env
    });
    
  }, 120000);

  // Clean up the test project directory after all tests
  afterAll(() => {
    rmSync(projectDirectory, { recursive: true, force: true });
    logger.info(`Cleaned up test project directory: ${projectDirectory}`);
  });

  // Ensure package has been locally installed
  it('nx-fhir package should be installed', () => {
    const listCommand = getListCommand(packageManager, 'nx-fhir');
    execSync(listCommand, {
      cwd: projectDirectory,
      stdio: 'inherit'
    });
  });

  // Check that the generator runs
  it('should run the server generator', async () => {
    execSync(getExecuteCommand(packageManager, `nx generate nx-fhir:server --directory=${options.directory} --packageBase=${options.packageBase} --release=${options.release}`), {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: process.env
    });
  }, 120000);

  // Verify that some expected files exist
  it('should verify extracted files exist', () => {
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
  });

  it ('should verify server project can be found in workspace', async () => {

    let result = execSync(getExecuteCommand(packageManager, 'nx reset'), {
      cwd: projectDirectory,
      env: process.env
    }).toString();
    
    // run nx show projects and verify server is listed
    result = execSync(getExecuteCommand(packageManager, 'nx show projects'), {
      cwd: projectDirectory,
      env: process.env
    }).toString();
    expect(result).toContain('server');
  }, 60000);

  // Start the server and query the /fhir/metadata endpoint
  it('should start the generated server successfully and provide /fhir/metadata', async () => {
    logger.info(`Starting the server with command: ${getExecuteCommand(packageManager)} nx serve server in ${projectDirectory}`);
    const { spawn } = await import('child_process');
    const serverProcess = spawn(getExecuteCommand(packageManager), ['nx', 'serve', 'server'], {
      cwd: projectDirectory,
      shell: true,
      detached: true,
    });

    // Unref so the parent process can exit independently
    serverProcess.unref();

    let output = '';

    // Promise that will resolve if the server starts successfully
    const startPromise = new Promise<void>((resolve, reject) => {
      serverProcess.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        output += chunk;
        if (chunk.includes('Started Application in')) {
          logger.info(`Found server start message: ${chunk}`);
          resolve();
        }
      });
      serverProcess.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
      });
      serverProcess.on('error', (err) => {
        reject(err);
      });
      serverProcess.on('close', (code) => {
        if (code !== 0 && !output.includes('Started Application in')) {
          reject(new Error(`Process exited with code ${code}\n${output}`));
        } else {
          resolve();
        }
      });
    });

    try {
      await startPromise;
      // Query the /fhir/metadata endpoint
      const response = await fetch('http://localhost:8080/fhir/metadata');
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toBeTruthy();
      expect(data.resourceType).toBe('CapabilityStatement');
    } catch (error) {
      logger.error(`Failed to start server or query /fhir/metadata: ${error}`);
      throw error;
    }
    finally {
      // Kill the entire process tree to ensure Java server is terminated
      if (serverProcess.pid) {
        try {
          // Try to kill the process group first (negative PID)
          process.kill(-serverProcess.pid, 'SIGTERM');
          
          // Give it a moment to clean up gracefully
          await new Promise((resolve) => setTimeout(resolve, 2000));
          
          // Force kill if still running
          try {
            process.kill(-serverProcess.pid, 'SIGKILL');
          } catch (e) {
            // Process already terminated, ignore
          }
        } catch (err) {
          // If process group kill fails, fall back to killing just the main process
          try {
            serverProcess.kill('SIGTERM');
            await new Promise((resolve) => setTimeout(resolve, 2000));
            serverProcess.kill('SIGKILL');
          } catch (e) {
            logger.warn(`Failed to kill server process: ${e}`);
          }
        }
      }
    }
  }, 120000);
});


function createTestProject() {

  rmSync(projectDirectory, { recursive: true, force: true });
  mkdirSync(dirname(projectDirectory), { recursive: true });

  execSync(getExecuteCommand(detectPackageManager(), `create-nx-workspace@latest ${projectName} --preset apps --nxCloud=skip --no-interactive --skip-git`), {
    cwd: dirname(projectDirectory),
    stdio: 'inherit',
    env: process.env
  });
  logger.info(`Created test project at ${projectDirectory}`);
  
  return projectDirectory;
}


