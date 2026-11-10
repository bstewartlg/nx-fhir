import {
  detectPackageManager,
  getProjects,
  globAsync,
  joinPathFragments,
  ProjectConfiguration,
  readJson,
  Tree,
} from '@nx/devkit';
import { readdirSync } from 'fs';
import { join } from 'path';
import { ServerProjectConfiguration } from '../models';
import {
  isCombinedDockerfile,
  isServerRootLayout,
  legacyDockerWarning,
  renderDockerFragments,
} from './docker-splice';
import type { OutcomeLine } from './index';
import {
  getCiInstallCommand,
  getDockerBaseImage,
  getLockfileName,
  getRunCommand,
} from './package-manager';

/**
 * File names the frontend generator's docker templates produce next to the
 * frontend project: the combined frontend + server Dockerfile and its
 * .dockerignore. Derived from the shipped template directory so the list
 * cannot drift from what the generator actually writes.
 */
export function integrationDockerFileNames(): string[] {
  const dockerTemplatesDir = join(
    __dirname,
    '../../generators/frontend/files/docker'
  );
  return readdirSync(dockerTemplatesDir).map((name) =>
    name.replace(/\.template$/, '').replace(/^__dot__/, '.')
  );
}

/**
 * Reads the server root out of a frontend project's copy-to-server target.
 * The target only exists when the frontend generator integrated the project
 * with a server, and its commands name the server root explicitly, so it is
 * the durable record of which server the integration files were written for.
 */
export function getIntegratedServerRoot(
  projectConfig: ProjectConfiguration
): string | null {
  const commands =
    projectConfig.targets?.['copy-to-server']?.options?.commands;
  if (!Array.isArray(commands)) {
    return null;
  }
  for (const command of commands) {
    if (typeof command !== 'string') {
      continue;
    }
    const match = command.match(
      /\.\.\/(.*?)\/src\/main\/resources\/static/
    );
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** The frontend projects whose copy-to-server target writes into the server at serverRoot. */
export function getIntegratedFrontends(
  tree: Tree,
  serverRoot: string
): ProjectConfiguration[] {
  return Array.from(getProjects(tree).values()).filter(
    (project) => getIntegratedServerRoot(project) === serverRoot
  );
}

/**
 * True when a frontend project integrated with the server at serverRoot
 * writes its docker files inside that server root. This happens when the
 * server directory directly contains the frontend project, most commonly a
 * server imported at the workspace root with the frontend generated in a
 * directory beneath it.
 */
export function integrationOwnsServerDockerFiles(
  projects: Iterable<ProjectConfiguration>,
  serverRoot: string
): boolean {
  const normalize = (value: string) => join(value).replace(/\\/g, '/');
  for (const projectConfig of projects) {
    if (getIntegratedServerRoot(projectConfig) !== serverRoot) {
      continue;
    }
    if (normalize(join(projectConfig.root, '..')) === normalize(serverRoot)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the root package.json registers projectRoot as a workspace. A
 * member is a directory with a package.json that a workspaces pattern
 * matches. A member installs from the workspace root, so it uses the root
 * lockfile. The workspaces field is either a
 * pattern array or an object with a packages array.
 */
export async function isRootWorkspaceMember(
  tree: Tree,
  projectRoot: string
): Promise<boolean> {
  if (!tree.exists('package.json')) {
    return false;
  }
  const { workspaces } = readJson(tree, 'package.json');
  const patterns = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  const manifests = await globAsync(
    tree,
    patterns.map((pattern) => `${pattern}/package.json`)
  );
  return manifests.includes(`${projectRoot}/package.json`);
}

/**
 * True when the server has the starter's container health check source. The
 * starter ships it from 8.10.0-1, and the combined Dockerfile compiles it only
 * when it is present, so older servers still build.
 */
export function hasServerHealthCheck(tree: Tree, serverRoot: string): boolean {
  return tree.exists(join(serverRoot, 'src/main/java/HealthCheck.java'));
}

/**
 * The variables the docker templates and fragments render with. The frontend
 * generator and the frontend migration must render with equal values, or a
 * docker file that the user did not change merges as a user change.
 */
export async function frontendDockerVars(
  tree: Tree,
  frontendRoot: string,
  serverRoot: string
): Promise<Record<string, string | boolean>> {
  const packageManager = detectPackageManager(tree.root);
  return {
    dot: '.',
    frontendRoot,
    serverRoot,
    dockerBaseImage: getDockerBaseImage(packageManager),
    lockfileName: getLockfileName(packageManager),
    ciInstallCommand: getCiInstallCommand(packageManager),
    buildCommand: getRunCommand(packageManager, 'build'),
    workspaceMember: await isRootWorkspaceMember(tree, frontendRoot),
    healthCheck: hasServerHealthCheck(tree, serverRoot),
  };
}

/**
 * Tells the owner of each combined Dockerfile at the server root how to move
 * to the starter's own Dockerfile. The update runs this once, after the
 * server and frontend updates. A server update runs once for each release
 * step, so the warning stays out of it. The caller prints the lines.
 */
export async function legacyDockerfileWarnings(
  tree: Tree
): Promise<OutcomeLine[]> {
  const projects = Array.from(getProjects(tree).values());
  const lines: OutcomeLine[] = [];

  for (const frontend of projects) {
    const serverRoot = getIntegratedServerRoot(frontend);
    if (serverRoot === null || !isServerRootLayout(serverRoot, frontend.root)) {
      continue;
    }

    const dockerfile = tree.read(
      joinPathFragments(serverRoot, 'Dockerfile'),
      'utf-8'
    );
    if (dockerfile === null || !isCombinedDockerfile(dockerfile)) {
      continue;
    }

    const fragments = renderDockerFragments(
      join(__dirname, '../../generators/frontend/files'),
      await frontendDockerVars(tree, frontend.root, serverRoot)
    );
    if (fragments === null) {
      continue;
    }

    const server = projects.find((project) => project.root === serverRoot) as
      | ServerProjectConfiguration
      | undefined;
    for (const text of legacyDockerWarning(server?.hapiReleaseVersion, fragments)) {
      lines.push({ level: 'warn', text });
    }
  }

  return lines;
}
