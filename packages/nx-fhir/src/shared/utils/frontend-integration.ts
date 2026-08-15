import { ProjectConfiguration } from '@nx/devkit';
import { readdirSync } from 'fs';
import { join } from 'path';

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
