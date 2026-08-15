import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, addProjectConfiguration, readJson, readNxJson } from '@nx/devkit';
import { parse } from 'yaml';
import { FhirVersion, ServerProjectConfiguration } from '../models';

const select = vi.hoisted(() => vi.fn());

vi.mock('@inquirer/prompts', () => ({ select }));

import {
  registerNxPlugin,
  getServerProjects,
  promptForServerProject,
  getJavaType,
  updateServerYaml,
  removeServerYamlProperty,
  removeTesterSection,
} from './index';

const yamlPath = 'apps/server/src/main/resources/application.yaml';

const applicationYaml = `# HAPI FHIR server configuration
spring:
  datasource:
    url: jdbc:h2:mem:test
hapi:
  fhir:
    fhir_version: R4
    server_address: http://localhost:8080/fhir
`;

function addServer(tree: Tree, name: string) {
  const configuration: ServerProjectConfiguration = {
    root: `apps/${name}`,
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
    pluginVersion: '0.0.1',
  };
  addProjectConfiguration(tree, name, configuration);
  tree.write(`apps/${name}/pom.xml`, '<project></project>');
}

function addFrontend(tree: Tree, name: string) {
  addProjectConfiguration(tree, name, {
    root: `apps/${name}`,
    projectType: 'application',
    tags: ['nx-fhir-frontend'],
  });
}

describe('shared utils', () => {
  let tree: Tree;

  beforeEach(() => {
    vi.clearAllMocks();
    tree = createTreeWithEmptyWorkspace();
  });

  describe('registerNxPlugin', () => {
    it('should register the plugin and add the workspace scripts', async () => {
      await registerNxPlugin(tree);

      expect(readNxJson(tree)?.plugins).toEqual(['nx-fhir']);
      expect(readJson(tree, 'package.json').scripts).toEqual({
        build: 'nx run-many -t build',
        serve: 'nx run-many -t serve',
        test: 'nx run-many -t test',
      });
    });

    it('should not register the plugin twice when listed as a string', async () => {
      await registerNxPlugin(tree);
      await registerNxPlugin(tree);

      expect(readNxJson(tree)?.plugins).toEqual(['nx-fhir']);
    });

    it('should not register the plugin twice when listed as an object', async () => {
      const nxJson = readNxJson(tree);
      tree.write(
        'nx.json',
        JSON.stringify({ ...nxJson, plugins: [{ plugin: 'nx-fhir', options: {} }] }, null, 2),
      );

      await registerNxPlugin(tree);

      expect(readNxJson(tree)?.plugins).toEqual([{ plugin: 'nx-fhir', options: {} }]);
    });

    it('should keep plugins registered by other packages', async () => {
      const nxJson = readNxJson(tree);
      tree.write('nx.json', JSON.stringify({ ...nxJson, plugins: ['@nx/vite'] }, null, 2));

      await registerNxPlugin(tree);

      expect(readNxJson(tree)?.plugins).toEqual(['@nx/vite', 'nx-fhir']);
    });

    it('should not overwrite scripts the workspace already defines', async () => {
      const packageJson = readJson(tree, 'package.json');
      tree.write(
        'package.json',
        JSON.stringify({ ...packageJson, scripts: { build: 'custom build' } }, null, 2),
      );

      await registerNxPlugin(tree);

      const scripts = readJson(tree, 'package.json').scripts;
      expect(scripts.build).toBe('custom build');
      expect(scripts.serve).toBe('nx run-many -t serve');
    });

    it('should throw when the workspace has no nx.json', async () => {
      tree.delete('nx.json');

      await expect(registerNxPlugin(tree)).rejects.toThrow('nx.json not found');
    });

    it('should register the plugin in a workspace without a root package.json', async () => {
      tree.delete('package.json');

      await registerNxPlugin(tree);

      expect(readNxJson(tree)?.plugins).toEqual(['nx-fhir']);
      expect(tree.exists('package.json')).toBe(false);
    });
  });

  describe('getServerProjects', () => {
    it('should return an empty list for a workspace without applications', async () => {
      await expect(getServerProjects(tree)).resolves.toEqual([]);
    });

    it('should return only server applications', async () => {
      addServer(tree, 'server-one');
      addServer(tree, 'server-two');
      addFrontend(tree, 'web-app');
      addProjectConfiguration(tree, 'some-lib', {
        root: 'libs/some-lib',
        projectType: 'library',
      });

      await expect(getServerProjects(tree)).resolves.toEqual(['server-one', 'server-two']);
    });

    it('should exclude a plain Maven application without fhirVersion', async () => {
      addProjectConfiguration(tree, 'plain-maven', {
        root: 'apps/plain-maven',
        projectType: 'application',
      });
      tree.write('apps/plain-maven/pom.xml', '<project></project>');

      await expect(getServerProjects(tree)).resolves.toEqual([]);
    });

    it('should exclude a project with fhirVersion but no pom.xml', async () => {
      addServer(tree, 'half-generated');
      tree.delete('apps/half-generated/pom.xml');

      await expect(getServerProjects(tree)).resolves.toEqual([]);
    });

    it('should include a tagged server without a fhirVersion key', async () => {
      addProjectConfiguration(tree, 'legacy-server', {
        root: 'apps/legacy-server',
        projectType: 'application',
        tags: ['nx-fhir-server'],
      });
      tree.write('apps/legacy-server/pom.xml', '<project></project>');

      await expect(getServerProjects(tree)).resolves.toEqual(['legacy-server']);
    });
  });

  describe('promptForServerProject', () => {
    it('should throw when the workspace has no server project', async () => {
      await expect(promptForServerProject(tree)).rejects.toThrow('No server projects found');
    });

    it('should return the only server project without prompting', async () => {
      addServer(tree, 'server-one');

      await expect(promptForServerProject(tree)).resolves.toBe('server-one');
      expect(select).not.toHaveBeenCalled();
    });

    it('should prompt with every server project when there is more than one', async () => {
      addServer(tree, 'server-one');
      addServer(tree, 'server-two');
      select.mockResolvedValue('server-two');

      await expect(promptForServerProject(tree)).resolves.toBe('server-two');
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({ choices: ['server-one', 'server-two'] }),
      );
    });
  });

  describe('getJavaType', () => {
    it('should map a FHIR primitive to its HAPI type', () => {
      expect(getJavaType('string')).toBe('StringType');
      expect(getJavaType('boolean')).toBe('BooleanType');
      expect(getJavaType('positiveInt')).toBe('PositiveIntType');
      expect(getJavaType('base64Binary')).toBe('Base64BinaryType');
    });

    it('should return void for a primitive output parameter', () => {
      expect(getJavaType('string', true)).toBe('void');
      expect(getJavaType('dateTime', true)).toBe('void');
    });

    it('should return void when no type is given', () => {
      expect(getJavaType('')).toBe('void');
      expect(getJavaType(undefined as unknown as string)).toBe('void');
    });

    it('should map the generic Resource type to IAnyResource', () => {
      expect(getJavaType('Resource')).toBe('IAnyResource');
      expect(getJavaType('Resource', true)).toBe('IAnyResource');
    });

    it('should pass complex types through unchanged', () => {
      expect(getJavaType('Patient')).toBe('Patient');
      expect(getJavaType('Bundle', true)).toBe('Bundle');
      expect(getJavaType('CodeableConcept')).toBe('CodeableConcept');
    });
  });

  describe('updateServerYaml', () => {
    beforeEach(() => {
      tree.write(yamlPath, applicationYaml);
    });

    it('should set a nested property', () => {
      updateServerYaml('apps/server', tree, 'hapi.fhir.fhir_version', 'R5');

      expect(parse(tree.read(yamlPath, 'utf-8') as string).hapi.fhir.fhir_version).toBe('R5');
    });

    it('should add a property that does not exist yet', () => {
      updateServerYaml('apps/server', tree, 'hapi.fhir.cors.allowed_origin', '*');

      const config = parse(tree.read(yamlPath, 'utf-8') as string);
      expect(config.hapi.fhir.cors.allowed_origin).toBe('*');
      expect(config.hapi.fhir.fhir_version).toBe('R4');
    });

    it('should keep comments in the file', () => {
      updateServerYaml('apps/server', tree, 'hapi.fhir.fhir_version', 'R5');

      expect(tree.read(yamlPath, 'utf-8')).toContain('# HAPI FHIR server configuration');
    });

    it('should throw when the configuration file is missing', () => {
      expect(() => updateServerYaml('apps/other', tree, 'hapi.fhir.fhir_version', 'R5')).toThrow(
        'Configuration file not found at',
      );
    });
  });

  describe('removeServerYamlProperty', () => {
    beforeEach(() => {
      tree.write(yamlPath, applicationYaml);
    });

    it('should delete a nested property and leave its siblings', () => {
      removeServerYamlProperty('apps/server', tree, 'hapi.fhir.server_address');

      const config = parse(tree.read(yamlPath, 'utf-8') as string);
      expect(config.hapi.fhir.server_address).toBeUndefined();
      expect(config.hapi.fhir.fhir_version).toBe('R4');
    });

    it('should leave the file unchanged when the property is absent', () => {
      removeServerYamlProperty('apps/server', tree, 'hapi.fhir.not_there');

      expect(parse(tree.read(yamlPath, 'utf-8') as string).hapi.fhir.fhir_version).toBe('R4');
    });

    it('should throw when the configuration file is missing', () => {
      expect(() => removeServerYamlProperty('apps/other', tree, 'hapi.fhir.fhir_version')).toThrow(
        'Configuration file not found at',
      );
    });
  });

  describe('removeTesterSection', () => {
    // Shaped like the released HAPI application.yaml: a banner comment block
    // above the section, and a following section separated by a blank line.
    const testerBlock = `    tester:
      home:
        name: Local Tester
        server_address: 'http://localhost:8080/fhir'
        fhir_version: R4
`;
    const releaseYaml = `hapi:
  fhir:
    # -------------------------------------------------------------------------------
    # R. LastN (analytics)
    # -------------------------------------------------------------------------------
    # lastn_enabled: true

    # -------------------------------------------------------------------------------
    # S. Testers (webui)
    # -------------------------------------------------------------------------------
${testerBlock}
    # -------------------------------------------------------------------------------
    # T. Outbound HTTP client
    # -------------------------------------------------------------------------------
    inline_resource_storage_below_size: 4000
`;

    it('should remove the tester block and leave every other byte in place', () => {
      expect(removeTesterSection(releaseYaml)).toBe(releaseYaml.replace(testerBlock, ''));
    });

    it('should keep the comment block above the section', () => {
      const result = removeTesterSection(releaseYaml);

      expect(result).toContain('    # S. Testers (webui)\n');
      expect(result).not.toContain('Local Tester');
    });

    it('should keep the blank line that separates the next section', () => {
      expect(removeTesterSection(releaseYaml)).toContain(
        '    # -------------------------------------------------------------------------------\n\n    # -------------------------------------------------------------------------------\n    # T. Outbound HTTP client',
      );
    });

    it('should remove a section that ends the file', () => {
      const endOfFileYaml = `hapi:
  fhir:
    fhir_version: R4
${testerBlock}`;

      expect(removeTesterSection(endOfFileYaml)).toBe(`hapi:
  fhir:
    fhir_version: R4
`);
    });

    it('should return content without a tester section unchanged', () => {
      expect(removeTesterSection(applicationYaml)).toBe(applicationYaml);
    });

    it('should leave the parsed document equal to the original minus the tester', () => {
      const original = parse(releaseYaml);
      const result = parse(removeTesterSection(releaseYaml));

      expect(result.hapi.fhir.tester).toBeUndefined();
      delete original.hapi.fhir.tester;
      expect(result).toEqual(original);
    });
  });
});
