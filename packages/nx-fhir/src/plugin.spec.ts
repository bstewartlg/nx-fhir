import type { CreateNodesContext, CreateNodesResult } from '@nx/devkit';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodes, createNodesV2 } from './plugin';

const createNodesFunction = createNodes[1];

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-fhir-plugin-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function writeProjectFiles(
  projectRoot: string,
  files: Record<string, string>,
): string {
  mkdirSync(join(workspaceRoot, projectRoot), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(workspaceRoot, projectRoot, name), contents);
  }
  return `${projectRoot}/project.json`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function context(): CreateNodesContext {
  return { workspaceRoot, nxJsonConfiguration: {} };
}

async function inferNodes(configFile: string): Promise<CreateNodesResult> {
  const results = await createNodesFunction([configFile], {}, context());
  return results[0][1];
}

function serverProject(
  projectRoot: string,
  projectJson: Record<string, unknown> = {},
): string {
  return writeProjectFiles(projectRoot, {
    'pom.xml': '<project></project>',
    'project.json': json({ name: 'server', fhirVersion: 'R4', ...projectJson }),
  });
}

function frontendProject(
  projectRoot: string,
  packageJson: Record<string, unknown> = {},
  projectJson: Record<string, unknown> = {},
): string {
  return writeProjectFiles(projectRoot, {
    'package.json': json({
      name: 'frontend',
      devDependencies: { '@types/fhir': '^0.0.41' },
      ...packageJson,
    }),
    'project.json': json({ name: 'frontend', ...projectJson }),
  });
}

describe('createNodes registration', () => {
  it('matches every project.json in the workspace', () => {
    expect(createNodes[0]).toBe('**/project.json');
  });

  it('exposes the same tuple as createNodesV2', () => {
    expect(createNodesV2).toBe(createNodes);
  });
});

describe('server project inference', () => {
  it('infers targets, tags and metadata from pom.xml plus fhirVersion', async () => {
    const configFile = serverProject('apps/fhir-server');

    expect(await inferNodes(configFile)).toEqual({
      projects: {
        'apps/fhir-server': {
          targets: {
            build: {
              executor: 'nx-fhir:build',
              cache: true,
              inputs: [
                'default',
                '^production',
                '{projectRoot}/pom.xml',
                '{projectRoot}/src/**/*.java',
              ],
              outputs: ['{projectRoot}/target'],
              options: {
                production: true,
                skipTests: false,
              },
            },
            test: {
              executor: 'nx-fhir:test',
              cache: true,
              inputs: [
                'default',
                '^production',
                '{projectRoot}/pom.xml',
                '{projectRoot}/src/**/*.java',
              ],
              outputs: ['{projectRoot}/target/surefire-reports'],
              options: {},
            },
            serve: {
              executor: 'nx-fhir:serve',
              options: {},
            },
          },
          tags: ['fhir', 'server', 'nx-fhir-server'],
          metadata: {
            description: 'HAPI FHIR based server application',
            technologies: ['hapi', 'java', 'spring-boot', 'fhir'],
          },
        },
      },
    });
  });

  it('keeps targets that project.json already defines', async () => {
    const configFile = serverProject('apps/fhir-server', {
      targets: {
        build: { executor: 'nx:run-commands' },
        serve: { executor: 'nx:run-commands' },
      },
    });

    const nodes = await inferNodes(configFile);

    expect(
      Object.keys(nodes.projects?.['apps/fhir-server'].targets ?? {}),
    ).toEqual(['test']);
  });

  it('appends the fhir tags to the tags already declared', async () => {
    const configFile = serverProject('apps/fhir-server', {
      tags: ['scope:api', 'server'],
    });

    const nodes = await inferNodes(configFile);

    expect(nodes.projects?.['apps/fhir-server'].tags).toEqual([
      'scope:api',
      'server',
      'fhir',
      'nx-fhir-server',
    ]);
  });

  it('adds nothing when every target and tag is already declared', async () => {
    const configFile = serverProject('apps/fhir-server', {
      tags: ['fhir', 'server', 'nx-fhir-server'],
      targets: {
        build: { executor: 'nx:run-commands' },
        test: { executor: 'nx:run-commands' },
        serve: { executor: 'nx:run-commands' },
      },
    });

    const nodes = await inferNodes(configFile);

    expect(nodes.projects?.['apps/fhir-server'].targets).toEqual({});
    expect(nodes.projects?.['apps/fhir-server'].tags).toEqual([
      'fhir',
      'server',
      'nx-fhir-server',
    ]);
  });

  it('ignores a pom.xml when project.json omits fhirVersion', async () => {
    const configFile = writeProjectFiles('apps/plain-java', {
      'pom.xml': '<project></project>',
      'project.json': json({ name: 'plain-java' }),
    });

    expect(await inferNodes(configFile)).toEqual({});
  });

  it('ignores fhirVersion when no pom.xml is present', async () => {
    const configFile = writeProjectFiles('apps/no-pom', {
      'project.json': json({ name: 'no-pom', fhirVersion: 'R4' }),
    });

    expect(await inferNodes(configFile)).toEqual({});
  });

  it('prefers the server fingerprint over the frontend fingerprint', async () => {
    const configFile = writeProjectFiles('apps/hybrid', {
      'pom.xml': '<project></project>',
      'package.json': json({
        name: 'hybrid',
        devDependencies: { '@types/fhir': '^0.0.41' },
      }),
      'project.json': json({ name: 'hybrid', fhirVersion: 'R5' }),
    });

    const nodes = await inferNodes(configFile);

    expect(nodes.projects?.['apps/hybrid'].tags).toContain('nx-fhir-server');
  });
});

describe('frontend project inference', () => {
  it('infers targets, tags and metadata from the @types/fhir dev dependency', async () => {
    const configFile = frontendProject('apps/web');

    expect(await inferNodes(configFile)).toEqual({
      projects: {
        'apps/web': {
          targets: {
            build: {
              executor: 'nx-fhir:build',
              cache: true,
              inputs: [
                'production',
                '^production',
                '{projectRoot}/package.json',
                '{projectRoot}/vite.config.ts',
                '{projectRoot}/tsconfig.json',
              ],
              outputs: ['{projectRoot}/dist'],
              options: {
                production: true,
              },
            },
            test: {
              executor: 'nx-fhir:test',
              cache: true,
              inputs: [
                'default',
                '^production',
                '{projectRoot}/package.json',
                '{projectRoot}/vitest.config.ts',
              ],
              options: {},
            },
            serve: {
              executor: 'nx-fhir:serve',
            },
          },
          tags: ['fhir', 'frontend', 'nx-fhir-frontend'],
          metadata: {
            description: 'TanStack Router based FHIR client application',
            technologies: ['vite', 'tanstack', 'react', 'typescript', 'fhir'],
          },
        },
      },
    });
  });

  it('infers a frontend from the nx-fhir-frontend tag in package.json', async () => {
    const configFile = frontendProject('apps/web', {
      devDependencies: {},
      tags: ['nx-fhir-frontend'],
    });

    const nodes = await inferNodes(configFile);

    expect(nodes.projects?.['apps/web'].tags).toEqual([
      'fhir',
      'frontend',
      'nx-fhir-frontend',
    ]);
  });

  it('adds nothing when every target and tag is already declared', async () => {
    const configFile = frontendProject(
      'apps/web',
      {},
      {
        tags: ['fhir', 'frontend', 'nx-fhir-frontend'],
        targets: {
          build: { executor: 'nx:run-commands' },
          test: { executor: 'nx:run-commands' },
          serve: { executor: 'nx:run-commands' },
        },
      },
    );

    const nodes = await inferNodes(configFile);

    expect(nodes.projects?.['apps/web'].targets).toEqual({});
    expect(nodes.projects?.['apps/web'].tags).toEqual([
      'fhir',
      'frontend',
      'nx-fhir-frontend',
    ]);
  });

  it('does not infer a frontend from the nx-fhir-frontend tag in project.json', async () => {
    const configFile = frontendProject(
      'apps/web',
      { devDependencies: {} },
      { tags: ['nx-fhir-frontend'] },
    );

    expect(await inferNodes(configFile)).toEqual({});
  });

  it('does not infer a frontend when @types/fhir is a runtime dependency', async () => {
    const configFile = frontendProject('apps/web', {
      devDependencies: {},
      dependencies: { '@types/fhir': '^0.0.41' },
    });

    expect(await inferNodes(configFile)).toEqual({});
  });

  it('keeps targets that project.json already defines', async () => {
    const configFile = frontendProject(
      'apps/web',
      {},
      {
        targets: {
          test: { executor: 'nx:run-commands' },
          serve: { executor: 'nx:run-commands' },
        },
      },
    );

    const nodes = await inferNodes(configFile);

    expect(Object.keys(nodes.projects?.['apps/web'].targets ?? {})).toEqual([
      'build',
    ]);
  });

  it('appends the fhir tags to the tags already declared', async () => {
    const configFile = frontendProject(
      'apps/web',
      {},
      { tags: ['scope:ui', 'frontend'] },
    );

    const nodes = await inferNodes(configFile);

    expect(nodes.projects?.['apps/web'].tags).toEqual([
      'scope:ui',
      'frontend',
      'fhir',
      'nx-fhir-frontend',
    ]);
  });
});

describe('unrecognized projects', () => {
  it('returns no nodes for a project with neither fingerprint', async () => {
    const configFile = writeProjectFiles('libs/util', {
      'project.json': json({ name: 'util' }),
      'package.json': json({ name: 'util' }),
    });

    expect(await inferNodes(configFile)).toEqual({});
  });

  it('returns no nodes when project.json does not exist', async () => {
    expect(await inferNodes('apps/missing/project.json')).toEqual({});
  });

  it('returns no nodes for a malformed project.json', async () => {
    const configFile = writeProjectFiles('apps/broken', {
      'pom.xml': '<project></project>',
      'project.json': '{ "name": ',
    });

    expect(await inferNodes(configFile)).toEqual({});
  });

  it('returns no nodes for a malformed package.json', async () => {
    const configFile = writeProjectFiles('apps/broken', {
      'project.json': json({ name: 'broken' }),
      'package.json': '{ "devDependencies": ',
    });

    expect(await inferNodes(configFile)).toEqual({});
  });
});

describe('batch invocation', () => {
  it('returns one result per config file in the order given', async () => {
    const server = serverProject('apps/fhir-server');
    const frontend = frontendProject('apps/web');
    const other = writeProjectFiles('libs/util', {
      'project.json': json({ name: 'util' }),
    });

    const results = await createNodesFunction(
      [server, frontend, other],
      {},
      context(),
    );

    expect(results.map(([file]) => file)).toEqual([server, frontend, other]);
    expect(Object.keys(results[0][1].projects ?? {})).toEqual([
      'apps/fhir-server',
    ]);
    expect(Object.keys(results[1][1].projects ?? {})).toEqual(['apps/web']);
    expect(results[2][1]).toEqual({});
  });

  it('does not throw when one config file in the batch is malformed', async () => {
    const server = serverProject('apps/fhir-server');
    const broken = writeProjectFiles('apps/broken', {
      'project.json': '{ "name": ',
    });

    const results = await createNodesFunction([broken, server], {}, context());

    expect(results[0][1]).toEqual({});
    expect(Object.keys(results[1][1].projects ?? {})).toEqual([
      'apps/fhir-server',
    ]);
  });
});
