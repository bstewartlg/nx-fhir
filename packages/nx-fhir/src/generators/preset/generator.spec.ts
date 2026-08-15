import { vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, getProjects, readJson, readProjectConfiguration } from '@nx/devkit';

const { confirm, input, select } = vi.hoisted(() => ({
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({ confirm, input, select }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

import { presetGenerator } from './generator';
import { PresetGeneratorSchema } from './schema';
import { FhirVersion } from '../../shared/models';

function writeRootServer(tree: Tree) {
  tree.write(
    'pom.xml',
    `<project>
  <artifactId>hapi-fhir-jpaserver-starter</artifactId>
  <version>8.8.0</version>
  <parent><artifactId>hapi-fhir</artifactId><version>8.8.0</version></parent>
</project>`,
  );
  tree.write(
    'src/main/resources/application.yaml',
    'hapi:\n  fhir:\n    fhir_version: R4\n',
  );
}

describe('preset generator', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    process.argv.push('--dry-run'); // Ensure dry-run mode for tests
    vi.clearAllMocks();
    isInteractive.mockReturnValue(false);
  });

  it('should run successfully without server', async () => {
    const options: PresetGeneratorSchema = {
      name: 'test',
      server: false,
      directory: 'fhir-app'
    };
    
    await presetGenerator(tree, options);
    
    // Check that workspace configuration exists
    expect(tree.exists('nx.json')).toBe(true);
  });

  it('should opt the workspace out of Nx analytics', async () => {
    await presetGenerator(tree, {
      name: 'test',
      server: false,
      directory: 'fhir-app',
    });

    expect(readJson(tree, 'nx.json').analytics).toBe(false);
  });

  it('should add Nx artifacts to an existing .gitignore that lacks them', async () => {
    tree.write('.gitignore', 'target/\n*.log\n');

    await presetGenerator(tree, {
      name: 'test',
      server: false,
      directory: 'fhir-app',
    });

    const content = tree.read('.gitignore', 'utf-8');
    expect(content).toContain('target/');
    expect(content).toContain('node_modules');
    expect(content).toContain('.nx/cache');
    expect(content).toContain('.nx/workspace-data');
  });

  it('should create .gitignore when the workspace has none', async () => {
    tree.delete('.gitignore');

    await presetGenerator(tree, {
      name: 'test',
      server: false,
      directory: 'fhir-app',
    });

    expect(tree.read('.gitignore', 'utf-8')).toBe(
      'node_modules\n.nx/cache\n.nx/workspace-data\n',
    );
  });

  it('should leave .gitignore untouched when entries are already present', async () => {
    const original = '/node_modules\n.nx/cache\n.nx/workspace-data\n';
    tree.write('.gitignore', original);

    await presetGenerator(tree, {
      name: 'test',
      server: false,
      directory: 'fhir-app',
    });

    expect(tree.read('.gitignore', 'utf-8')).toBe(original);
  });

  it('should keep an analytics choice the workspace already made', async () => {
    const nxJson = readJson(tree, 'nx.json');
    tree.write('nx.json', JSON.stringify({ ...nxJson, analytics: true }));

    await presetGenerator(tree, {
      name: 'test',
      server: false,
      directory: 'fhir-app',
    });

    expect(readJson(tree, 'nx.json').analytics).toBe(true);
  });

  it('should create server project when server option is true', async () => {
    const options: PresetGeneratorSchema = {
      name: 'test',
      server: true,
      directory: 'fhir-app',
      serverDirectory: 'server',
      packageBase: 'org.test.server',
      fhirVersion: FhirVersion.R4,
      release: '8.4.0-2'
    };
    
    await presetGenerator(tree, options);
    
    // The server generator creates a project with name based on the directory basename
    const config = readProjectConfiguration(tree, 'server');
    expect(config).toBeDefined();
    expect(config.root).toBe('server');
    expect(config.tags).toContain('nx-fhir-server');
  });

  it('imports an existing server at the root instead of scaffolding a new one', async () => {
    writeRootServer(tree);

    const options: PresetGeneratorSchema = {
      name: 'test',
      server: true,
      directory: 'fhir-app',
      release: '8.8.0-1',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    };

    await presetGenerator(tree, options);

    // Imported as a root project; no new "server" directory was scaffolded.
    expect(tree.exists('server/pom.xml')).toBe(false);

    const rootProject = Array.from(getProjects(tree).values()).find(
      (p) => p.root === '.',
    );
    expect(rootProject).toBeDefined();
    expect(rootProject?.tags).toContain('nx-fhir-server');

    const projectJson = readJson(tree, 'project.json');
    expect(projectJson.hapiReleaseVersion).toBe('8.8.0-1');
    expect(projectJson.fhirVersion).toBe('R4');
  });

  it('names the imported project from the workspace name answer, not the directory', async () => {
    writeRootServer(tree);

    // Mirrors a user answering the "name" prompt with a value distinct from the directory.
    const options: PresetGeneratorSchema = {
      name: 'fhir-app',
      server: true,
      directory: 'fhir-app',
      release: '8.8.0-1',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    };

    await presetGenerator(tree, options);

    const config = readProjectConfiguration(tree, 'fhir-app');
    expect(config.root).toBe('.');
    expect(readJson(tree, 'project.json').name).toBe('fhir-app');
  });

  it('imports an existing server without prompting when the server option is omitted', async () => {
    writeRootServer(tree);

    // No `server` flag: detection must run first and import the existing server.
    // If detection did not short-circuit, this would block on a confirm prompt.
    const options: PresetGeneratorSchema = {
      name: 'test',
      directory: 'fhir-app',
      release: '8.8.0-1',
      fhirVersion: FhirVersion.R4,
      packageBase: 'org.test.server',
    };

    await presetGenerator(tree, options);

    expect(tree.exists('server/pom.xml')).toBe(false);
    const rootProject = Array.from(getProjects(tree).values()).find(
      (p) => p.root === '.',
    );
    expect(rootProject).toBeDefined();
    expect(rootProject?.tags).toContain('nx-fhir-server');
  });

  it('does not import when the server option is explicitly false', async () => {
    writeRootServer(tree);

    const options: PresetGeneratorSchema = {
      name: 'test',
      server: false,
      directory: 'fhir-app',
    };

    await presetGenerator(tree, options);

    // An explicit opt-out is honored even when a server is present.
    const rootProject = Array.from(getProjects(tree).values()).find(
      (p) => p.root === '.',
    );
    expect(rootProject).toBeUndefined();
    expect(tree.exists('project.json')).toBe(false);
  });

  it('generates a server with the prompt defaults when it cannot ask', async () => {
    // No terminal: every unanswered option must fall back to the value the
    // prompt offers as its default rather than blocking on a prompt.
    await presetGenerator(tree, {
      name: 'test',
      directory: 'fhir-app',
      release: '8.4.0-2',
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();

    const config = readProjectConfiguration(tree, 'server');
    expect(config.root).toBe('server');
    expect(readJson(tree, 'server/project.json')).toMatchObject({
      packageBase: 'org.custom.server',
      fhirVersion: 'R4',
      hapiReleaseVersion: '8.4.0-2',
    });
  });

  it('generates a server from the prompt answers when it can ask', async () => {
    isInteractive.mockReturnValue(true);
    confirm.mockResolvedValue(true);
    input
      .mockResolvedValueOnce('apps/hapi')
      .mockResolvedValueOnce('com.example.custom');
    select.mockResolvedValue('R4B');

    await presetGenerator(tree, {
      name: 'test',
      directory: 'fhir-app',
      release: '8.4.0-2',
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledTimes(2);

    const config = readProjectConfiguration(tree, 'hapi');
    expect(config.root).toBe('apps/hapi');
    expect(readJson(tree, 'apps/hapi/project.json')).toMatchObject({
      packageBase: 'com.example.custom',
      fhirVersion: 'R4B',
    });
  });

  it('generates nothing when the user declines the server prompt', async () => {
    isInteractive.mockReturnValue(true);
    confirm.mockResolvedValue(false);

    await presetGenerator(tree, {
      name: 'test',
      directory: 'fhir-app',
      release: '8.4.0-2',
    });

    // Declining stops before any of the follow-up prompts.
    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(Array.from(getProjects(tree).keys())).toEqual([]);
  });

  it('does not prompt for options the caller already provided', async () => {
    isInteractive.mockReturnValue(true);
    confirm.mockResolvedValue(true);

    await presetGenerator(tree, {
      name: 'test',
      directory: 'fhir-app',
      serverDirectory: 'svc',
      packageBase: 'org.given.base',
      fhirVersion: FhirVersion.STU3,
      release: '8.4.0-2',
    });

    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(readJson(tree, 'svc/project.json')).toMatchObject({
      packageBase: 'org.given.base',
      fhirVersion: 'STU3',
    });
  });
});
