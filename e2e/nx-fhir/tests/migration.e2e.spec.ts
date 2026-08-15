// vitest-environment node
import { logger, workspaceRoot } from '@nx/devkit';
import { execSync, spawn } from 'child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { parseDocument } from 'yaml';
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
const projectName = `test-migration-${crypto.randomUUID()}`;
const projectDirectory = join(tmpdir(), projectName);
const nxFhirBuildPath = join(workspaceRoot, 'dist/packages/nx-fhir');
const nxFhirPackPath = join(nxFhirBuildPath, `nx-fhir-${pluginVersion}.tgz`);

const packageManager = getPackageManager();

const cleanEnv = buildCleanEnv();

// The server is generated three releases behind the target so the update
// chains 8.8.0-1 -> 8.10.0-1 -> 8.10.0-2 -> 8.10.0-3, which is the only way to
// prove the resolver walks the migration graph instead of taking one hop.
const startRelease = '8.8.0-1';
const targetRelease = '8.10.0-3';

// The newest nx-fhir on npm that still ships the common/ + template/ frontend
// file layout the migration expects. The frontend is generated with this
// published version and migrated to the local build.
const publishedFrontendVersion = '0.2.1';

// Replaces the upstream default of 8080 before the migration and is asserted
// afterwards. server.port sits well outside every region the 8.8.0-1 to
// 8.10.0-3 releases touch, so a correct three-way merge has no reason to drop
// or conflict on it.
const customServerPort = 8383;

// Appended to a frontend hook the current templates also changed, so the merge
// has to combine an upstream edit with a user edit in the same file.
const frontendCustomizationMarker = 'NX_FHIR_MIGRATION_E2E_MARKER';

// Upper bound for an update generator. A healthy run downloads a handful of
// archives and merges them in a couple of minutes, so anything beyond this is
// reported as a failure rather than left to grind against the test timeout.
const updateGeneratorTimeout = 600000;

describe('migration e2e test', () => {
  beforeAll(async () => {
    logger.info(
      `Running migration e2e test with package manager: ${packageManager}`,
    );
    logger.info(`Workspace root: ${workspaceRoot}`);

    execSync(getExecuteCommand(packageManager, 'nx build nx-fhir'), {
      stdio: 'inherit',
      cwd: workspaceRoot,
      env: cleanEnv,
    });

    const packCommand = getPackCommand(packageManager);
    logger.info(`Packing nx-fhir package: ${packCommand}`);
    execSync(packCommand, {
      cwd: nxFhirBuildPath,
      stdio: 'inherit',
      env: cleanEnv,
    });

    expect(existsSync(nxFhirPackPath)).toBe(true);

    createTestProject();

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

    // The update generators refuse to run unless the workspace is a clean git
    // repository, and create-nx-workspace was told to skip git. Maven output is
    // excluded so the commit between the two tests stays small.
    appendFileSync(join(projectDirectory, '.gitignore'), '\ntarget\n');
    execSync('git init -q', {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });
  }, 600000);

  afterAll(async () => {
    try {
      rmSync(projectDirectory, { recursive: true, force: true });
      logger.info(`Cleaned up test project directory: ${projectDirectory}`);
    } catch {
      // Ignore
    }
  });

  it('should chain HAPI server migrations, keep user changes and still compile', async () => {
    const generateCommand = getExecuteCommand(
      packageManager,
      `nx generate nx-fhir:server --directory=server --packageBase=org.custom.server --release=${startRelease}`,
    );
    logger.info(
      `Generating FHIR server at ${startRelease}: ${generateCommand}`,
    );
    execSync(generateCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });

    expect(readServerProjectJson().hapiReleaseVersion).toBe(startRelease);

    // The single user customization the three-way merge has to preserve
    const applicationYamlPath = join(
      projectDirectory,
      'server/src/main/resources/application.yaml',
    );
    const applicationYaml = parseDocument(
      readFileSync(applicationYamlPath, 'utf-8'),
    );
    applicationYaml.setIn(['server', 'port'], customServerPort);
    writeFileSync(applicationYamlPath, applicationYaml.toString());

    commitAll('generated server');

    // Clear stale project graph state so the update generator sees the project
    // that was just created
    execSync(getExecuteCommand(packageManager, 'nx reset'), {
      cwd: projectDirectory,
      env: cleanEnv,
    });

    logger.info(`Updating server to ${targetRelease}`);
    await runUpdateGenerator([
      'nx',
      'generate',
      'nx-fhir:update-server',
      '--project=server',
      `--targetVersion=${targetRelease}`,
    ]);

    expect(readServerProjectJson().hapiReleaseVersion).toBe(targetRelease);

    // The starter records its HAPI version as the parent POM version
    const pomXml = readFileSync(
      join(projectDirectory, 'server/pom.xml'),
      'utf-8',
    );
    const parentBlock = pomXml.match(/<parent>[\s\S]*?<\/parent>/)?.[0] ?? '';
    expect(parentBlock).toContain('<version>8.10.0</version>');

    // An uncustomized upgrade path should merge without manual intervention.
    // Anything left here is a real conflict the user would have to resolve.
    expect(findConflictedFiles(join(projectDirectory, 'server'))).toEqual([]);

    const migratedYaml = parseDocument(
      readFileSync(applicationYamlPath, 'utf-8'),
    ).toJS();
    expect(migratedYaml.server.port).toBe(customServerPort);
    // The migrated file also has to carry the upstream change, otherwise the
    // merge simply kept the old file and preserved the port by doing nothing
    expect(migratedYaml.management.endpoint.health.access).toBe('read_only');

    logger.info('Building the migrated server with Maven...');
    execSync(
      getExecuteCommand(packageManager, 'nx build server --skipTests=true'),
      {
        cwd: projectDirectory,
        stdio: 'inherit',
        env: cleanEnv,
      },
    );
    expect(existsSync(join(projectDirectory, 'server/target'))).toBe(true);
  }, 1800000);

  it('should migrate a frontend from a published template version to the current one', async () => {
    // The frontend is generated with the published old plugin so the files on
    // disk really are the old template, formatting drift included, and the
    // merge has genuine upstream changes to apply.
    const installOldPlugin = getInstallCommand(
      packageManager,
      `nx-fhir@${publishedFrontendVersion}`,
      true,
    );
    logger.info(`Installing published plugin: ${installOldPlugin}`);
    execSync(installOldPlugin, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });

    const generateCommand = getExecuteCommand(
      packageManager,
      'nx generate nx-fhir:frontend frontend --template=browser --server=server',
    );
    logger.info(
      `Generating frontend with nx-fhir@${publishedFrontendVersion}: ${generateCommand}`,
    );
    execSync(generateCommand, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });

    const frontendProjectJsonPath = join(
      projectDirectory,
      'frontend/project.json',
    );
    const frontendProjectJson = JSON.parse(
      readFileSync(frontendProjectJsonPath, 'utf-8'),
    );
    expect(frontendProjectJson.frontendVersion).toBe(publishedFrontendVersion);

    const hookPath = join(
      projectDirectory,
      'frontend/src/hooks/use-fhir-api.ts',
    );
    // The arrival assertion after the migration is only meaningful if the
    // marker is absent from the old template.
    expect(readFileSync(hookPath, 'utf-8')).not.toContain(
      'CapabilityStatementRestResource',
    );
    appendFileSync(
      hookPath,
      `\nexport const ${frontendCustomizationMarker} = true;\n`,
    );

    // bun reports a DependencyLoop when a local tarball is installed over the
    // registry entry of the same package, so the old plugin is removed first.
    const removeOldPlugin =
      packageManager === 'bun' ? 'bun remove nx-fhir' : 'npm uninstall nx-fhir';
    const installCurrentPlugin = getInstallCommand(
      packageManager,
      nxFhirPackPath,
      true,
    );
    logger.info(`Reinstalling current plugin build: ${installCurrentPlugin}`);
    execSync(removeOldPlugin, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });
    execSync(installCurrentPlugin, {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });

    commitAll('generated frontend');

    // Clear stale project graph state so the update generator and the build
    // target see the project that was just created
    execSync(getExecuteCommand(packageManager, 'nx reset'), {
      cwd: projectDirectory,
      env: cleanEnv,
    });

    logger.info(`Updating frontend to ${pluginVersion}`);
    await runUpdateGenerator([
      'nx',
      'generate',
      'nx-fhir:update-frontend',
      '--project=frontend',
      `--targetVersion=${pluginVersion}`,
    ]);

    const migratedProjectJson = JSON.parse(
      readFileSync(frontendProjectJsonPath, 'utf-8'),
    );
    expect(migratedProjectJson.frontendVersion).toBe(pluginVersion);

    // The 0.2.1 generator did not register the frontend as an npm workspace,
    // so the migration installs from the project directory and the workspace
    // root lockfile, which pins every other project, must survive untouched
    const rootLockfile =
      packageManager === 'bun' ? 'bun.lock' : 'package-lock.json';
    expect(existsSync(join(projectDirectory, rootLockfile))).toBe(true);

    expect(findConflictedFiles(join(projectDirectory, 'frontend'))).toEqual([]);

    const migratedHook = readFileSync(hookPath, 'utf-8');
    expect(migratedHook).toContain(frontendCustomizationMarker);
    // Present only in the current template, so its arrival proves the upstream
    // change was applied rather than the user file simply being left alone
    expect(migratedHook).toContain('CapabilityStatementRestResource');

    logger.info('Building the migrated frontend...');
    execSync(getExecuteCommand(packageManager, 'nx build frontend'), {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    });
    expect(existsSync(join(projectDirectory, 'frontend/dist/index.html'))).toBe(
      true,
    );
  }, 1800000);
});

function createTestProject() {
  logger.info(`Creating project directory at: ${projectDirectory}`);
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

function commitAll(message: string) {
  // The identity is passed per command because CI containers have no global
  // git configuration and the update generators only need a clean tree.
  const identity =
    '-c user.email=e2e@nx-fhir.invalid -c user.name="nx-fhir e2e"';
  execSync(`git ${identity} add -A`, {
    cwd: projectDirectory,
    stdio: 'inherit',
    env: cleanEnv,
  });
  // Signing and hooks are disabled because a developer global git config that
  // enables either of them would fail the commit in this throwaway repository.
  execSync(
    `git ${identity} commit -q --no-gpg-sign --no-verify -m "${message}"`,
    {
      cwd: projectDirectory,
      stdio: 'inherit',
      env: cleanEnv,
    },
  );
}

/**
 * Runs an update generator in the test workspace and fails if it does not
 * finish within `updateGeneratorTimeout`.
 *
 * The child is detached so it gets its own process group and a timeout can
 * kill the whole tree (the package runner, then nx, then the generator).
 * Killing only the top process leaves the generator running and holding a CPU
 * for the rest of the job.
 */
async function runUpdateGenerator(args: string[]): Promise<void> {
  const child = spawn(getExecuteCommand(packageManager), args, {
    cwd: projectDirectory,
    env: cleanEnv,
    // stdin is closed so the confirmation the generator raises after a
    // conflicted migration step aborts instead of waiting for an answer
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child.pid);
  }, updateGeneratorTimeout);

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    if (timedOut) {
      throw new Error(
        `${args.join(' ')} did not finish within ${updateGeneratorTimeout} ms`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(`${args.join(' ')} exited with code ${exitCode}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function killProcessTree(pid: number | undefined) {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      // A negative pid signals the whole process group
      process.kill(-pid, 'SIGKILL');
    }
  } catch (err) {
    logger.warn(`Failed to kill the generator process tree: ${err}`);
  }
}

function readServerProjectJson() {
  return JSON.parse(
    readFileSync(join(projectDirectory, 'server/project.json'), 'utf-8'),
  );
}

/**
 * Returns every file below `directory` that still holds a diff3 conflict
 * marker. Build output and installed packages are skipped because they can
 * legitimately contain the marker inside minified sources.
 */
function findConflictedFiles(directory: string): string[] {
  const skipped = new Set(['node_modules', 'target', 'dist', '.git']);
  const conflicted: string[] = [];

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skipped.has(entry.name)) {
        continue;
      }
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (readFileSync(fullPath, 'utf-8').includes('<<<<<<<')) {
        conflicted.push(relative(directory, fullPath));
      }
    }
  };

  walk(directory);
  return conflicted;
}
