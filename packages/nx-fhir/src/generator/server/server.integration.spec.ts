// vitest-environment node
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, logger, readProjectConfiguration } from '@nx/devkit';
import { serverGenerator } from './server';
import { ServerGeneratorSchema } from './schema';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';

describe('server generator integration test', () => {
  let tree: Tree;
  const testProjectPath = 'tmp/test-project';
  const options: ServerGeneratorSchema = {
    directory: 'server',
    packagePath: 'org.custom.server',
    release: 'image/v8.2.0-2',
  };
  
  const originalCwd = process.cwd();


  // Ensure the test project directory exists before running tests
  beforeAll(async () => {
    mkdirSync(testProjectPath, { recursive: true });
    tree = createTreeWithEmptyWorkspace();
  });

  // Change to the test project directory before running tests
  beforeEach(() => {
    process.chdir(join(originalCwd, testProjectPath));
  });

  // Ensure changes are written to the file system after each test
  afterEach(() => {
    for (const file of tree.listChanges().filter(f => f.type === 'CREATE' || f.type === 'UPDATE')) {
      const filePath = join(process.cwd(), file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content);
    }

    process.chdir(originalCwd);
  });

  // Clean up the test project directory after all tests
  afterAll(() => {
    rmSync(testProjectPath, { recursive: true, force: true });
    logger.info(`Cleaned up test project directory: ${testProjectPath}`);
  });


  it(`should initialize a new nx project in ${testProjectPath}`, async () => {
    const { execSync } = await import('child_process');
    execSync('npx nx init --interactive=false', { stdio: 'inherit' });
    expect(tree.exists('nx.json')).toBe(true);
  });

  it('should run successfully and download/extract the archive', async () => {
    await serverGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'server');
    expect(config).toBeDefined();
  });

  it('should verify extracted files exist', () => {
    expect(tree.exists(`server/src/main/resources/application.yaml`)).toBe(true);
    expect(tree.exists(`server/src/main/java/ca/uhn/fhir/jpa/starter/AppProperties.java`)).toBe(true);
  });

  it('should start the generated server successfully', async () => {
      const { spawn } = await import('child_process');
      const serverProcess = spawn('npx', ['nx', 'start', 'server'], {
        detached: true,
        shell: process.platform === 'win32',
      });

      let output = '';
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
      } finally {
        if (serverProcess.pid) {
          process.kill(-serverProcess.pid, 'SIGKILL');
        }
      }
    }, 120000);
});
