import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, getProjects, readJson, readProjectConfiguration } from '@nx/devkit';

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

  it('should create server project when server option is true', async () => {
    const options: PresetGeneratorSchema = {
      name: 'test',
      server: true,
      directory: 'fhir-app',
      serverDirectory: 'server',
      packageBase: 'org.test.server',
      fhirVersion: FhirVersion.R4,
      release: '8.4.0'
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
});
