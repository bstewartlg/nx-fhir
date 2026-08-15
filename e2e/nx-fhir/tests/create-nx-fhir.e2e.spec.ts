// vitest-environment node
import { logger, workspaceRoot } from '@nx/devkit';
import { execSync, spawn, ChildProcess } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { getPackageManager } from '@nx-fhir/shared/utils/package-manager';
import { buildCleanEnv } from './utils';

const pluginVersion = JSON.parse(
  readFileSync(join(workspaceRoot, 'packages/nx-fhir/package.json'), 'utf-8'),
).version;
const createVersion = JSON.parse(
  readFileSync(
    join(workspaceRoot, 'packages/create-nx-fhir/package.json'),
    'utf-8',
  ),
).version;

const packageManager = getPackageManager();

const runId = crypto.randomUUID();
// Everything the test writes outside the repo lives under this directory so a
// single recursive delete cleans up registry storage, caches, and workspaces
const scratchDir = join(tmpdir(), `create-nx-fhir-e2e-${runId}`);
// HOME is redirected here for the create flow so npx/bunx caches and lockfiles
// that contain local registry URLs never leak into the real user caches, where
// they would break later installs once the registry is gone
const scratchHome = join(scratchDir, 'home');
const scratchTmp = join(scratchDir, 'tmp');
const bunInstallDir = join(scratchDir, 'bun');
const registryStorage = join(scratchDir, 'registry-storage');
const verdaccioConfigPath = join(scratchDir, 'verdaccio.yaml');
const workspaceParent = join(scratchDir, 'workspaces');
const workspaceName = 'fhir-workspace';
const workspaceDir = join(workspaceParent, workspaceName);
// The "." flows initialize nx-fhir inside a directory that already exists
const initWorkspaceDir = join(workspaceParent, 'init-existing');
const importWorkspaceDir = join(workspaceParent, 'import-existing');
// Unix domain sockets cap the path around 108 chars; nx would place its daemon
// socket under the deep scratch workspace path and fail to open it
const nxSocketDir = join(tmpdir(), `nx-sock-${runId.slice(0, 8)}`);
// A run killed before afterAll leaves its scratch directories behind. Anything
// older than this belongs to a run that is no longer alive
const STALE_ARTIFACT_AGE_MS = 2 * 60 * 60 * 1000;
const STALE_ARTIFACT_PREFIXES = ['create-nx-fhir-e2e-', 'nx-sock-'];

// --yes keeps npx from prompting to install the uncached package
const executor = packageManager === 'bun' ? 'bunx' : 'npx --yes';

let registryPort: number;
let registryUrl: string;
let registryProcess: ChildProcess | undefined;
let registryEnv: NodeJS.ProcessEnv;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine free port')));
      }
    });
  });
}

async function waitForRegistry(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/-/ping`);
      if (response.ok) {
        return;
      }
    } catch {
      // Registry not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Verdaccio did not become ready within ${timeoutMs}ms`);
}

function removeStrayTarballs(distDir: string): void {
  // The server e2e packs a .tgz into the dist folder; npm publish of the
  // folder would bundle it into the published tarball
  for (const entry of readdirSync(distDir)) {
    if (entry.endsWith('.tgz')) {
      unlinkSync(join(distDir, entry));
    }
  }
}

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function runCreate(command: string, cwd: string): void {
  // stdin is closed and CI is set so any interactive prompt in the create
  // flow fails fast instead of waiting forever, invisible under the nx TUI
  execSync(command, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...registryEnv, CI: 'true' },
  });
}

function signalRegistry(signal: NodeJS.Signals): void {
  if (!registryProcess?.pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${registryProcess.pid} /T /F`, {
        stdio: 'ignore',
      });
    } else {
      // Negative pid targets the detached process group, so Verdaccio and any
      // worker it forked go down together
      process.kill(-registryProcess.pid, signal);
    }
  } catch {
    // Already gone
  }
}

function removeScratchArtifacts(): void {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(nxSocketDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

/**
 * Removes the scratch directories left behind by runs that were interrupted
 * before their cleanup ran. Only directories this suite creates are considered,
 * and only once they are too old to belong to a run still in progress. No
 * process is ever matched by name, because a developer may be running their own
 * Verdaccio for local publishing.
 */
// create-nx-workspace installs nx into a tmp-<pid>-<hash> directory and
// leaves it behind when its process tree is killed. At roughly 87 MB each
// these fill the temp filesystem over repeated e2e runs.
function isAbandonedCreateNxWorkspaceDir(
  entry: string,
  candidate: string,
): boolean {
  if (!/^tmp-\d+-/.test(entry)) {
    return false;
  }
  try {
    const packageJson = JSON.parse(
      readFileSync(join(candidate, 'package.json'), 'utf-8'),
    );
    const dependencyNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });
    return dependencyNames.length === 1 && dependencyNames[0] === 'nx';
  } catch {
    return false;
  }
}

function removeStaleArtifacts(): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }

  for (const entry of entries) {
    const candidate = join(tmpdir(), entry);
    if (
      !STALE_ARTIFACT_PREFIXES.some((prefix) => entry.startsWith(prefix)) &&
      !isAbandonedCreateNxWorkspaceDir(entry, candidate)
    ) {
      continue;
    }
    try {
      const stats = statSync(candidate);
      if (!stats.isDirectory()) {
        continue;
      }
      if (Date.now() - stats.mtimeMs < STALE_ARTIFACT_AGE_MS) {
        continue;
      }
      rmSync(candidate, { recursive: true, force: true });
      logger.info(`Removed stale e2e artifact: ${candidate}`);
    } catch {
      // Owned by another user or already removed
    }
  }
}

// Ctrl+C reaches the test runner but not Verdaccio, which runs in its own
// process group, so afterAll never gets the chance to clean up
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    signalRegistry('SIGTERM');
    signalRegistry('SIGKILL');
    removeScratchArtifacts();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

describe('create-nx-fhir e2e test', () => {
  beforeAll(async () => {
    logger.info(
      `Running create-nx-fhir e2e test with package manager: ${packageManager}`,
    );

    // The bin installs nx-fhir at its own package version, so the two packages
    // must be versioned together for the registry flow to resolve
    expect(createVersion).toBe(pluginVersion);

    removeStaleArtifacts();

    for (const dir of [
      scratchHome,
      scratchTmp,
      bunInstallDir,
      registryStorage,
      workspaceParent,
      nxSocketDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    registryPort = await getFreePort();
    registryUrl = `http://127.0.0.1:${registryPort}`;

    // Registry override and auth are scoped to child process env and a .npmrc
    // under the scratch HOME; the real user config is never touched
    writeFileSync(
      join(scratchHome, '.npmrc'),
      [
        `registry=${registryUrl}`,
        `//127.0.0.1:${registryPort}/:_authToken=nx-fhir-e2e`,
        '',
      ].join('\n'),
    );
    // create-nx-workspace commits the new workspace; the scratch HOME has no
    // git identity so provide one
    writeFileSync(
      join(scratchHome, '.gitconfig'),
      '[user]\n\tname = nx-fhir e2e\n\temail = e2e@nx-fhir.invalid\n',
    );

    registryEnv = buildCleanEnv({
      HOME: scratchHome,
      TMPDIR: scratchTmp,
      NX_SOCKET_DIR: nxSocketDir,
      // bun reads its cache location from BUN_INSTALL, not from HOME, and keys
      // entries by version. Both packages are always published as the same
      // version, so without this the run silently installs the tarball an
      // earlier run left in the developer cache instead of the one just built
      BUN_INSTALL: bunInstallDir,
      BUN_INSTALL_CACHE_DIR: join(bunInstallDir, 'install/cache'),
      npm_config_registry: registryUrl,
      NPM_CONFIG_REGISTRY: registryUrl,
      BUN_CONFIG_REGISTRY: registryUrl,
      [`npm_config_//127.0.0.1:${registryPort}/:_authToken`]: 'nx-fhir-e2e',
    });
    // Vitest sets NODE_ENV=test, and the create-nx-fhir bin skips its main()
    // under NODE_ENV=test (a guard for its unit tests). End users never run
    // with that value, so remove it from the child environment
    delete registryEnv.NODE_ENV;

    writeFileSync(
      verdaccioConfigPath,
      [
        `storage: ${registryStorage}`,
        'uplinks:',
        '  npmjs:',
        '    url: https://registry.npmjs.org/',
        '    maxage: 60m',
        'packages:',
        `  '**':`,
        '    access: $all',
        '    publish: $all',
        '    unpublish: $all',
        '    proxy: npmjs',
        'web:',
        '  enable: false',
        'log:',
        '  type: stdout',
        '  format: pretty',
        '  level: warn',
        'publish:',
        '  allow_offline: true',
        '',
      ].join('\n'),
    );

    logger.info(`Starting Verdaccio on ${registryUrl}...`);
    // detached gives Verdaccio its own process group so the whole tree can be
    // killed together during cleanup
    registryProcess = spawn(
      process.execPath,
      [
        join(workspaceRoot, 'node_modules/verdaccio/bin/verdaccio'),
        '--config',
        verdaccioConfigPath,
        '--listen',
        `127.0.0.1:${registryPort}`,
      ],
      {
        cwd: workspaceRoot,
        env: buildCleanEnv(),
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      },
    );
    await waitForRegistry(registryUrl, 30000);

    // Build and publish both packages to the local registry
    logger.info('Building nx-fhir and create-nx-fhir packages...');
    execSync('npx nx run-many -t build -p nx-fhir,create-nx-fhir', {
      cwd: workspaceRoot,
      stdio: 'inherit',
      env: buildCleanEnv(),
    });

    for (const pkg of ['nx-fhir', 'create-nx-fhir']) {
      const distDir = join(workspaceRoot, 'dist/packages', pkg);
      removeStrayTarballs(distDir);
      logger.info(`Publishing ${pkg}@${pluginVersion} to ${registryUrl}...`);
      // --tag is mandatory for prerelease versions like 0.0.0-dev; the flow
      // installs by exact version so the tag itself is never consumed
      execSync(`npm publish ${distDir} --registry=${registryUrl} --tag e2e`, {
        cwd: workspaceRoot,
        stdio: 'inherit',
        env: registryEnv,
      });
    }
  }, 600000);

  afterAll(async () => {
    signalRegistry('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    signalRegistry('SIGKILL');

    removeScratchArtifacts();
    logger.info(`Cleaned up scratch directory: ${scratchDir}`);
  });

  it('should create a workspace with a server through the published packages', async () => {
    const createCommand =
      `${executor} create-nx-fhir@${createVersion} ${workspaceName}` +
      ` --packageManager=${packageManager}` +
      ' --server=true --serverDirectory=server' +
      ' --packageBase=org.custom.server --release=8.10.0-3 --fhirVersion=R4';

    logger.info(`Creating workspace: ${createCommand}`);
    runCreate(createCommand, workspaceParent);

    expect(existsSync(join(workspaceDir, 'nx.json'))).toBe(true);

    const workspacePackageJson = readJsonFile(
      join(workspaceDir, 'package.json'),
    );
    expect(
      workspacePackageJson.devDependencies?.['nx-fhir'] ??
        workspacePackageJson.dependencies?.['nx-fhir'],
    ).toBeTruthy();

    const expectedServerFiles = [
      'server/pom.xml',
      'server/src/main/resources/application.yaml',
      'server/project.json',
    ];
    for (const file of expectedServerFiles) {
      expect(existsSync(join(workspaceDir, file))).toBe(true);
    }

    const result = execSync(`${executor} nx show projects`, {
      cwd: workspaceDir,
      env: registryEnv,
    }).toString();
    expect(result).toContain('server');
  }, 900000);

  it('should initialize nx-fhir in an existing empty directory', async () => {
    mkdirSync(initWorkspaceDir, { recursive: true });

    const createCommand =
      `${executor} create-nx-fhir@${createVersion} .` +
      ` --packageManager=${packageManager} --server=false`;

    logger.info(`Initializing in place: ${createCommand}`);
    runCreate(createCommand, initWorkspaceDir);

    expect(existsSync(join(initWorkspaceDir, 'package.json'))).toBe(true);
    expect(existsSync(join(initWorkspaceDir, 'nx.json'))).toBe(true);

    const workspacePackageJson = readJsonFile(
      join(initWorkspaceDir, 'package.json'),
    );
    expect(workspacePackageJson.devDependencies?.['nx-fhir']).toBeTruthy();

    // The preset registers the plugin and the run-many scripts even when it
    // generates no server, so these prove the generator actually ran
    const nxJson = readJsonFile(join(initWorkspaceDir, 'nx.json'));
    expect(nxJson.plugins).toContain('nx-fhir');
    expect(workspacePackageJson.scripts?.build).toBe('nx run-many -t build');

    expect(existsSync(join(initWorkspaceDir, 'server'))).toBe(false);
  }, 900000);

  it('should import a pre-existing HAPI server instead of scaffolding one', async () => {
    // A server checkout that predates nx-fhir has no project.json, and target
    // is Maven build output that must not be carried over
    const excludedNames = new Set(['target', 'node_modules', '.git']);
    const sourceServerDir = join(workspaceDir, 'server');
    const sourceProjectJson = join(sourceServerDir, 'project.json');

    mkdirSync(importWorkspaceDir, { recursive: true });
    cpSync(sourceServerDir, importWorkspaceDir, {
      recursive: true,
      filter: (src) =>
        !excludedNames.has(basename(src)) && src !== sourceProjectJson,
    });

    const pomPath = join(importWorkspaceDir, 'pom.xml');
    const yamlPath = join(
      importWorkspaceDir,
      'src/main/resources/application.yaml',
    );
    const pomBefore = readFileSync(pomPath, 'utf-8');
    const yamlBefore = readFileSync(yamlPath, 'utf-8');

    // No --server flag: the preset must detect the server already in the
    // directory and import it rather than asking whether to generate one
    const createCommand =
      `${executor} create-nx-fhir@${createVersion} .` +
      ` --packageManager=${packageManager}`;

    logger.info(`Importing existing server: ${createCommand}`);
    runCreate(createCommand, importWorkspaceDir);

    const projectJsonPath = join(importWorkspaceDir, 'project.json');
    expect(existsSync(projectJsonPath)).toBe(true);

    const projectJson = readJsonFile(projectJsonPath);
    // Nx leaves "root" out of project.json because the file location implies
    // it; sourceRoot is what shows the server was imported where it already sat
    expect(projectJson.sourceRoot).toBe('src');
    expect(projectJson.tags).toContain('nx-fhir-server');
    expect(projectJson.fhirVersion).toBe('R4');
    // Identified exactly from the pom's parent version and starter revision
    expect(projectJson.hapiReleaseVersion).toBe('8.10.0-3');

    // Importing is non-destructive: the server sources are registered, never
    // regenerated over the top of what was there
    expect(readFileSync(pomPath, 'utf-8')).toBe(pomBefore);
    expect(readFileSync(yamlPath, 'utf-8')).toBe(yamlBefore);
    expect(existsSync(join(importWorkspaceDir, 'server'))).toBe(false);

    const result = execSync(`${executor} nx show projects`, {
      cwd: importWorkspaceDir,
      env: registryEnv,
    }).toString();
    expect(result).toContain(projectJson.name);
  }, 900000);
});
