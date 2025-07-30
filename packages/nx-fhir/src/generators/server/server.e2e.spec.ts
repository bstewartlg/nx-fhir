// vitest-environment node
import { logger, } from '@nx/devkit';
import { ServerGeneratorSchema } from './schema';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

describe('server generator e2e test', () => {
  // let tree: Tree;
  const options: ServerGeneratorSchema = {
    directory: 'server',
    packageBase: 'org.custom.server',
    release: 'image/v8.0.0',
  };
  
  let projectDirectory: string;


  // Ensure the test project directory exists before running tests
  beforeAll(async () => {
    logger.info(`Creating test project directory. CWD: ${process.cwd()}`);
    projectDirectory = createTestProject();

    execSync('npm install -D nx-fhir@e2e', {
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
    execSync('npm ls nx-fhir', {
      cwd: projectDirectory,
      stdio: 'inherit'
    });
  });

  // Check that the generator runs
  it('should run the server generator', async () => {
    execSync(`npx nx generate nx-fhir:server --directory=${options.directory} --packageBase=${options.packageBase} --release=${options.release}`, {
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
  })

  // Start the server and query the /fhir/metadata endpoint
  it('should start the generated server successfully and provide /fhir/metadata', async () => {
    logger.info('Starting the server with command: npx nx start server');
    const { spawn } = await import('child_process');
    const serverProcess = spawn('npx', ['nx', 'start', 'server'], {
      cwd: projectDirectory,
      shell: true
    });

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
      if (serverProcess.pid) {
        try {
          process.kill(serverProcess.pid, 0); // Check if process exists
          process.kill(serverProcess.pid, 'SIGKILL');
        } catch (e) {
          logger.warn(`Failed to kill server process: ${e}`);
          // Process already exited, ignore
        }
      }
    }
  }, 120000);
});


function createTestProject() {
  const projectName = 'test-project';
  const projectDirectory = join(process.cwd(), 'tmp', projectName);

  rmSync(projectDirectory, { recursive: true, force: true });
  mkdirSync(dirname(projectDirectory), { recursive: true });

  execSync(`npx --yes create-nx-workspace@latest ${projectName} --preset apps --nxCloud=skip --no-interactive`, {
    cwd: dirname(projectDirectory),
    stdio: 'inherit',
    env: process.env
  });
  logger.info(`Created test project at ${projectDirectory}`);
  
  return projectDirectory;
}
