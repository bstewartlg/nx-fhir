// vitest-environment node
import { logger, workspaceRoot } from '@nx/devkit';
import { ServerGeneratorSchema } from '@nx-fhir/generators/server/schema';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { parseDocument } from 'yaml';
import { execSync, spawn } from 'child_process';
import { FhirVersion } from '@nx-fhir/shared/models';
import { hostname, networkInterfaces, tmpdir } from 'os';
import {
  getExecuteCommand,
  getInstallCommand,
  getPackageManager,
  getPackCommand,
} from '@nx-fhir/shared/utils/package-manager';
import { buildCleanEnv } from './utils';

const pluginVersion = JSON.parse(
  readFileSync(join(workspaceRoot, 'packages/nx-fhir/package.json'), 'utf-8'),
).version;
// create-nx-workspace releases mirror the nx releases, so the workspace is
// created with the nx version this repository develops against. Using @latest
// breaks the e2e when a new Nx major ships, and it poisoned the bunx cache once.
const nxVersion = JSON.parse(
  readFileSync(join(workspaceRoot, 'package.json'), 'utf-8'),
).devDependencies.nx.replace(/^[\^~]/, '');
const projectName = `test-project-${crypto.randomUUID()}`;
const projectDirectory = join(tmpdir(), projectName);
const nxFhirBuildPath = join(workspaceRoot, 'dist/packages/nx-fhir');
const nxFhirPackPath = join(nxFhirBuildPath, `nx-fhir-${pluginVersion}.tgz`);

const packageManager = getPackageManager();

const cleanEnv = buildCleanEnv();

describe('server generator e2e test', () => {
  const options: ServerGeneratorSchema = {
    directory: 'server',
    packageBase: 'org.custom.server',
    release: '8.10.0-3',
    fhirVersion: FhirVersion.R4,
  };
  // Not the HAPI default of 8080, so the test both proves the generated
  // application.yaml drives the running server and avoids colliding with
  // whatever a developer already has on 8080.
  const serverPort = 8181;

  beforeAll(async () => {
    logger.info(
      `Running server e2e test with package manager: ${packageManager}`,
    );
    logger.info(`Creating test project directory. CWD: ${process.cwd()}`);
    logger.info(`Workspace root: ${workspaceRoot}`);
    logger.info(`Local hostname: ${hostname()}`);
    logger.info(`Network interfaces: ${JSON.stringify(networkInterfaces())}`);

    // Build the nx-fhir package
    logger.info(
      `Building nx-fhir package using command: ${getExecuteCommand(packageManager, 'nx build nx-fhir')}`,
    );
    execSync(getExecuteCommand(packageManager, 'nx build nx-fhir'), {
      stdio: 'inherit',
      cwd: workspaceRoot,
      env: cleanEnv,
    });

    // Pack the nx-fhir package
    const packCommand = getPackCommand(packageManager);
    logger.info(`Packing nx-fhir package: ${packCommand}`);
    execSync(packCommand, {
      cwd: nxFhirBuildPath,
      stdio: 'inherit',
      env: cleanEnv,
    });

    expect(existsSync(nxFhirPackPath)).toBe(true);
    logger.info(`Built package located at: ${nxFhirPackPath}`);

    // Create a new Nx workspace shared by all tests in this suite
    logger.info('Creating new Nx workspace...');
    createTestProject();

    // Install nx-fhir as a dev dependency
    const installCommand = getInstallCommand(
      packageManager,
      nxFhirPackPath,
      true,
    );
    logger.info(
      `Installing nx-fhir package into test workspace: ${installCommand}`,
    );
    execSync(installCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });
  }, 600000);

  afterAll(async () => {
    // Cleanup test project
    try {
      rmSync(projectDirectory, { recursive: true, force: true });
      logger.info(`Cleaned up test project directory: ${projectDirectory}`);
    } catch {
      // Ignore
    }
  });

  it('should complete full e2e flow: generate server -> start and query', async () => {
    // Generate a FHIR server
    const generateCommand = getExecuteCommand(
      packageManager,
      `nx generate nx-fhir:server --directory=${options.directory} --packageBase=${options.packageBase} --release=${options.release}`,
    );
    logger.info(`Operating in project directory: ${projectDirectory}`);
    logger.info(`Generating FHIR server: ${generateCommand}`);
    execSync(generateCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });

    // Verify generated files exist
    const expectedFiles = [
      'server/src/main/resources/application.yaml',
      'server/src/main/java/ca/uhn/fhir/jpa/starter/AppProperties.java',
      'server/.gitignore',
      'server/Dockerfile',
      'server/pom.xml',
    ];
    expectedFiles.forEach((file) => {
      const filePath = join(projectDirectory, file);
      expect(filePath).toBeTruthy();
      expect(existsSync(filePath)).toBe(true);
    });

    // Verify server project in workspace
    execSync(getExecuteCommand(packageManager, 'nx reset'), {
      cwd: projectDirectory,
      env: cleanEnv,
    });
    const result = execSync(
      getExecuteCommand(packageManager, 'nx show projects'),
      {
        cwd: projectDirectory,
        env: cleanEnv,
      },
    ).toString();
    expect(result).toContain('server');

    // Add a custom operation to the generated server. Every option is supplied
    // so the generator never falls back to an interactive prompt.
    const operationDirectory = `${options.packageBase.replace(/\./g, '/')}/providers`;
    const operationDefinitionPath = join(
      workspaceRoot,
      'e2e/nx-fhir/tests/fixtures/operation-definition.json',
    );
    const operationCommand = getExecuteCommand(
      packageManager,
      `nx generate nx-fhir:operation --project=server --defLocation="${operationDefinitionPath}" --directory=${operationDirectory}`,
    );
    logger.info(`Generating custom operation: ${operationCommand}`);
    execSync(operationCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });

    // The class name comes from the OperationDefinition id, with the Provider
    // suffix added because the definition declares a resource type.
    const operationJavaPath = join(
      projectDirectory,
      'server/src/main/java',
      operationDirectory,
      'PatientEchoProvider.java',
    );
    expect(existsSync(operationJavaPath)).toBe(true);

    // Point the server at a non-default port before booting it
    const applicationYamlPath = join(
      projectDirectory,
      'server/src/main/resources/application.yaml',
    );
    const applicationYaml = parseDocument(
      readFileSync(applicationYamlPath, 'utf-8'),
    );
    applicationYaml.setIn(['server', 'port'], serverPort);
    writeFileSync(applicationYamlPath, applicationYaml.toString());
    logger.info(`Set server port to ${serverPort} in ${applicationYamlPath}`);

    // Start the server
    logger.info('Starting the generated server...');
    // spring-boot:run compiles every Java source and Spring registers the
    // generated provider with the RestfulServer, so a successful boot proves
    // the generated operation compiles and is a valid HAPI provider.
    // detached gives the serve command its own process group so the whole tree
    // (npx -> nx -> maven -> java) can be killed together during cleanup.
    // Killing only the top process leaves the java server holding the port.
    const serverProcess = spawn(
      getExecuteCommand(packageManager),
      ['nx', 'serve', 'server'],
      {
        cwd: projectDirectory,
        env: cleanEnv,
        detached: process.platform !== 'win32',
      },
    );

    let output = '';
    let serverStarted = false;

    try {
      // Wait for server to start. The window must cover a cold Maven cache in CI,
      // where dependency downloads alone can take several minutes.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server failed to start within timeout'));
        }, 600000);

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
      logger.info(`Querying /fhir/metadata endpoint on port ${serverPort}...`);
      const response = await fetch(
        `http://localhost:${serverPort}/fhir/metadata`,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toBeTruthy();
      expect(data.resourceType).toBe('CapabilityStatement');
      // HAPI reports the R4 structure version, which proves the fhirVersion
      // option reached the running server, not just the generated files
      expect(data.fhirVersion).toBe('4.0.1');
    } finally {
      // Cleanup server process. Runs on failure too, so the java server never
      // outlives the test holding the port.
      if (serverProcess.pid) {
        try {
          if (process.platform === 'win32') {
            // Use taskkill on Windows to terminate the process tree
            execSync(`taskkill /pid ${serverProcess.pid} /T /F`, {
              stdio: 'ignore',
            });
          } else {
            // On Unix-like systems, signal the whole process group (negative pid),
            // then force kill any survivors so the java server releases the port
            process.kill(-serverProcess.pid, 'SIGTERM');
            await new Promise((resolve) => setTimeout(resolve, 2000));
            try {
              process.kill(-serverProcess.pid, 'SIGKILL');
            } catch {
              // Ignore
            }
          }
        } catch (err) {
          logger.warn(`Failed to cleanly kill server process: ${err}`);
        }
      }
    }

    // The implementation guide generator runs after the server is stopped. HAPI
    // downloads and installs every configured IG package at startup, so adding
    // one before the boot would make this test depend on the FHIR package
    // registry. validate=false keeps the generator itself offline: it writes the
    // package entry to the server config and nothing else.
    const igCommand = getExecuteCommand(
      packageManager,
      'nx generate nx-fhir:ig --project=server --id=hl7.fhir.us.core --igVersion=6.1.0 --validate=false --skipOps --skipCs',
    );
    logger.info(`Adding implementation guide: ${igCommand}`);
    execSync(igCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });

    const serverConfig = parseDocument(
      readFileSync(applicationYamlPath, 'utf-8'),
    ).toJS();
    expect(serverConfig.server.port).toBe(serverPort);
    expect(serverConfig.hapi.fhir.implementationguides.hl7fhiruscore).toEqual({
      name: 'hl7.fhir.us.core',
      version: '6.1.0',
      installMode: 'STORE_AND_INSTALL',
    });
  }, 900000);

  it('should generate frontend projects and build them against freshly resolved dependencies', async () => {
    const templates = ['browser', 'clinical'] as const;

    for (const template of templates) {
      const frontendDir = `frontend-${template}`;
      // --server avoids the interactive server-integration prompt and wires the
      // copy-to-server target. --navigationLayout avoids the clinical layout prompt.
      const layoutFlag =
        template === 'clinical' ? ' --navigationLayout=sidebar' : '';
      const generateCommand = getExecuteCommand(
        packageManager,
        `nx generate nx-fhir:frontend ${frontendDir} --template=${template} --server=server${layoutFlag}`,
      );
      logger.info(`Generating ${template} frontend: ${generateCommand}`);
      execSync(generateCommand, {
        cwd: projectDirectory,
        stdio: 'inherit',
        env: cleanEnv,
      });

      expect(
        existsSync(join(projectDirectory, frontendDir, 'package.json')),
      ).toBe(true);
      expect(
        existsSync(
          join(projectDirectory, frontendDir, 'src/routes/__root.tsx'),
        ),
      ).toBe(true);
    }

    // Clear stale project graph state before running targets on new projects
    execSync(getExecuteCommand(packageManager, 'nx reset'), {
      cwd: projectDirectory,
      env: cleanEnv,
    });

    for (const template of templates) {
      const frontendDir = `frontend-${template}`;
      // The build script is "vite build && tsc", so this compiles and
      // typechecks the template against the dependency versions resolved at
      // generation time, catching upstream breakage in caret ranges
      logger.info(`Building ${template} frontend...`);
      execSync(getExecuteCommand(packageManager, `nx build ${frontendDir}`), {
        cwd: projectDirectory,
        stdio: 'inherit',
        env: cleanEnv,
      });
      expect(
        existsSync(join(projectDirectory, frontendDir, 'dist/index.html')),
      ).toBe(true);
    }

    // Exercise the target the frontend generator added when it integrated with
    // the server project, which copies the built assets into the server
    logger.info('Copying browser frontend into the server static resources...');
    execSync(
      getExecuteCommand(packageManager, 'nx copy-to-server frontend-browser'),
      {
        cwd: projectDirectory,
        stdio: 'inherit',
        env: cleanEnv,
      },
    );
    expect(
      existsSync(
        join(projectDirectory, 'server/src/main/resources/static/index.html'),
      ),
    ).toBe(true);

    for (const template of templates) {
      logger.info(`Running frontend unit tests (${template} template)...`);
      execSync(
        getExecuteCommand(packageManager, `nx test frontend-${template}`),
        {
          cwd: projectDirectory,
          stdio: 'inherit',
          env: cleanEnv,
        },
      );
    }
  }, 900000);
});

function createTestProject() {
  logger.info(
    `Creating project directory at: ${projectDirectory} -- ${dirname(projectDirectory)}`,
  );
  rmSync(projectDirectory, { recursive: true, force: true });
  mkdirSync(dirname(projectDirectory), { recursive: true });

  execSync(
    getExecuteCommand(
      packageManager,
      `create-nx-workspace@${nxVersion} ${projectName} --preset apps --nxCloud=skip --no-interactive --skip-git`,
    ),
    {
      cwd: dirname(projectDirectory),
      stdio: 'inherit',
      env: cleanEnv,
    },
  );
  logger.info(`Created test project at ${projectDirectory}`);
}
