import { vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  logger,
  readProjectConfiguration,
  readJson,
} from '@nx/devkit';
import { parse } from 'yaml';

const select = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ select }));

import { frontendGenerator } from './frontend';
import { FrontendGeneratorSchema } from './schema';
import {
  FhirVersion,
  FrontendProjectConfiguration,
  ServerProjectConfiguration,
} from '../../shared/models';

describe('frontend generator', () => {
  let tree: Tree;
  const options: FrontendGeneratorSchema = { name: 'test-frontend' };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    vi.clearAllMocks();
  });

  it('should abort when the target directory already exists', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    tree.write('test-frontend/src/main.tsx', 'existing work');

    await frontendGenerator(tree, options);

    expect(errorSpy).toHaveBeenCalledWith(
      "Directory 'test-frontend' already exists. Aborting.",
    );
    // The existing file is left alone and no project is registered over it.
    expect(tree.read('test-frontend/src/main.tsx', 'utf-8')).toBe('existing work');
    expect(tree.exists('test-frontend/project.json')).toBe(false);
    errorSpy.mockRestore();
  });

  it('should create project configuration', async () => {
    await frontendGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test-frontend');
    expect(config).toBeDefined();
    expect(config.root).toBe('test-frontend');
    expect(config.projectType).toBe('application');
    expect(config.tags).toContain('nx-fhir-frontend');
  });

  it('should add project to root package.json workspaces', async () => {
    await frontendGenerator(tree, options);
    const rootPackageJson = readJson(tree, 'package.json');
    expect(rootPackageJson.workspaces).toContain('test-frontend');
  });

  it('should keep workspaces the root package.json already declares', async () => {
    const rootPackageJson = readJson(tree, 'package.json');
    tree.write(
      'package.json',
      JSON.stringify({ ...rootPackageJson, workspaces: ['packages/*'] }),
    );

    await frontendGenerator(tree, options);

    expect(readJson(tree, 'package.json').workspaces).toEqual([
      'packages/*',
      'test-frontend',
    ]);
  });

  it('should not duplicate workspaces entry when run twice', async () => {
    await frontendGenerator(tree, { name: 'frontend-a' });
    await frontendGenerator(tree, { name: 'frontend-b' });
    const rootPackageJson = readJson(tree, 'package.json');
    expect(rootPackageJson.workspaces).toContain('frontend-a');
    expect(rootPackageJson.workspaces).toContain('frontend-b');
    expect(rootPackageJson.workspaces.filter((w: string) => w === 'frontend-a').length).toBe(1);
  });

  it('should create vite.config.ts', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/vite.config.ts')).toBe(true);
  });

  it('should create TanStack router root file', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/routes/__root.tsx')).toBe(true);
  });

  it('should not include CDS hooks route', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/routes/hooks')).toBe(false);
  });

  it('should create package.json with TanStack dependencies', async () => {
    await frontendGenerator(tree, options);
    const packageJson = readJson(tree, 'test-frontend/package.json');
    expect(packageJson.dependencies['@tanstack/react-router']).toBeDefined();
    expect(packageJson.dependencies['@tanstack/react-query']).toBeDefined();
    expect(packageJson.dependencies['@tanstack/react-table']).toBeDefined();
    expect(packageJson.dependencies['react']).toBeDefined();
    expect(packageJson.dependencies['tailwindcss']).toBeDefined();
  });

  it('should track frontend version in project config', async () => {
    await frontendGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test-frontend');
    expect((config as FrontendProjectConfiguration).frontendVersion).toBeDefined();
    expect((config as FrontendProjectConfiguration).pluginVersion).toBeDefined();
  });

  it('should create index.html with FHIR Browser title', async () => {
    await frontendGenerator(tree, options);
    const indexHtml = tree.read('test-frontend/index.html', 'utf-8');
    expect(indexHtml).toContain('<title>FHIR Browser</title>');
  });

  it('should include vitest configuration', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/vitest.config.ts')).toBe(true);
    expect(tree.exists('test-frontend/vitest.setup.ts')).toBe(true);
  });

  it('should include biome configuration', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/biome.json')).toBe(true);
  });

  it('should create UI components', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/components/ui/button.tsx')).toBe(true);
    expect(tree.exists('test-frontend/src/components/ui/card.tsx')).toBe(true);
    expect(tree.exists('test-frontend/src/components/ui/dialog.tsx')).toBe(true);
  });

  it('should create FHIR-specific hooks', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/hooks/use-fhir-api.ts')).toBe(true);
    expect(tree.exists('test-frontend/src/hooks/use-fhir-server.ts')).toBe(true);
  });

  it('should not include CDS-related files', async () => {
    await frontendGenerator(tree, options);
    expect(tree.exists('test-frontend/src/hooks/use-cds-api.ts')).toBe(false);
    expect(tree.exists('test-frontend/src/hooks/use-cds-server.ts')).toBe(false);
    expect(tree.exists('test-frontend/src/lib/cds-config.ts')).toBe(false);
    expect(tree.exists('test-frontend/src/lib/cds-types.ts')).toBe(false);
  });

  it('should default to browser template when no template specified', async () => {
    await frontendGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test-frontend');
    expect((config as FrontendProjectConfiguration).frontendTemplate).toBe('browser');
    expect(config.tags).not.toContain('clinical');
    const indexHtml = tree.read('test-frontend/index.html', 'utf-8');
    expect(indexHtml).toContain('<title>FHIR Browser</title>');
  });

  it('should include Monaco editor in browser template dependencies', async () => {
    await frontendGenerator(tree, options);
    const packageJson = readJson(tree, 'test-frontend/package.json');
    expect(packageJson.dependencies['@monaco-editor/react']).toBeDefined();
    expect(packageJson.dependencies['@tanstack/react-virtual']).toBeDefined();
    expect(packageJson.dependencies['cmdk']).toBeDefined();
  });

  describe('server integration', () => {
    const serverRoot = 'test-server';
    const yamlPath = `${serverRoot}/src/main/resources/application.yaml`;

    // Shaped like the released HAPI application.yaml: a banner comment block
    // above the tester section, and a following section after a blank line.
    const testerBlock = `    tester:
      home:
        name: Local Tester
        server_address: 'http://localhost:8080/fhir'
        fhir_version: R4
`;
    const serverYaml = `hapi:
  fhir:
    fhir_version: R4

    # -------------------------------------------------------------------------------
    # S. Testers (webui)
    # -------------------------------------------------------------------------------
${testerBlock}
    # -------------------------------------------------------------------------------
    # T. Outbound HTTP client
    # -------------------------------------------------------------------------------
    inline_resource_storage_below_size: 4000
`;

    beforeEach(() => {
      const serverConfig: ServerProjectConfiguration = {
        root: serverRoot,
        projectType: 'application',
        sourceRoot: `${serverRoot}/src`,
        tags: ['fhir', 'server'],
        packageBase: 'com.example',
        fhirVersion: FhirVersion.R4,
        hapiReleaseVersion: '8.10.0-3',
        pluginVersion: '0.0.1',
      };
      addProjectConfiguration(tree, serverRoot, serverConfig);
      tree.write(yamlPath, serverYaml);
    });

    it('should remove only the tester section from the server configuration', async () => {
      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml.replace(testerBlock, ''));
    });

    it('should keep the comment block above the tester section', async () => {
      await frontendGenerator(tree, { ...options, server: serverRoot });

      const result = tree.read(yamlPath, 'utf-8') as string;
      expect(result).toContain('    # S. Testers (webui)\n');
      expect(result).not.toContain('Local Tester');
      expect(parse(result).hapi.fhir.tester).toBeUndefined();
      expect(parse(result).hapi.fhir.fhir_version).toBe('R4');
    });

    it('should leave a configuration without a tester section unchanged', async () => {
      const withoutTester = serverYaml.replace(testerBlock, '');
      tree.write(yamlPath, withoutTester);

      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read(yamlPath, 'utf-8')).toBe(withoutTester);
    });

    it('should preserve an existing Dockerfile as Dockerfile.orig before writing the combined one', async () => {
      tree.write('Dockerfile', 'FROM starter\n');

      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read('Dockerfile.orig', 'utf-8')).toBe('FROM starter\n');
      expect(tree.read('Dockerfile', 'utf-8')).toContain('build-frontend');
    });

    it('should keep the first backup when the integration runs again', async () => {
      tree.write('Dockerfile', 'FROM starter\n');
      tree.write('Dockerfile.orig', 'FROM original\n');

      await frontendGenerator(tree, { ...options, server: serverRoot });

      expect(tree.read('Dockerfile.orig', 'utf-8')).toBe('FROM original\n');
    });

    it('should integrate with the server the user picks when none is named', async () => {
      select.mockResolvedValue(serverRoot);
      const passedOptions = { ...options };

      await frontendGenerator(tree, passedOptions);

      // The picked server is used without writing it back to the caller's options.
      expect(passedOptions.server).toBeUndefined();
      expect(select).toHaveBeenCalledTimes(1);
      const config = readProjectConfiguration(tree, 'test-frontend');
      expect(config.targets?.['copy-to-server']).toBeDefined();
      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml.replace(testerBlock, ''));
    });

    it('should skip integration when the user picks no server', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      select.mockResolvedValue('none');

      await frontendGenerator(tree, { ...options });

      expect(select).toHaveBeenCalledTimes(1);
      // "none" is a deliberate skip, not a server that failed to resolve.
      expect(errorSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        'No server project selected for integration. Skipping integration step.',
      );
      const config = readProjectConfiguration(tree, 'test-frontend');
      expect(config.targets?.['copy-to-server']).toBeUndefined();
      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml);
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should report a named server project that is not in the workspace', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

      await frontendGenerator(tree, { ...options, server: 'no-such-server' });

      expect(errorSpy).toHaveBeenCalledWith(
        "Server project 'no-such-server' not found.",
      );
      // The frontend is still generated; only the integration step is skipped.
      const config = readProjectConfiguration(tree, 'test-frontend');
      expect(config.targets?.['copy-to-server']).toBeUndefined();
      expect(tree.read(yamlPath, 'utf-8')).toBe(serverYaml);
      errorSpy.mockRestore();
    });
  });

  describe('clinical template', () => {
    const clinicalOptions: FrontendGeneratorSchema = {
      name: 'test-clinical',
      template: 'clinical',
      navigationLayout: 'sidebar',
    };

    it('should create project config with clinical tag', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const config = readProjectConfiguration(tree, 'test-clinical');
      expect(config).toBeDefined();
      expect(config.tags).toContain('clinical');
      expect(config.tags).toContain('nx-fhir-frontend');
      expect(config.tags).toContain('fhir');
    });

    it('should store frontendTemplate in project config', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const config = readProjectConfiguration(tree, 'test-clinical');
      expect((config as FrontendProjectConfiguration).frontendTemplate).toBe('clinical');
      expect((config as FrontendProjectConfiguration).frontendVersion).toBeDefined();
    });

    it('should create index.html with Clinical Portal title', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const indexHtml = tree.read('test-clinical/index.html', 'utf-8');
      expect(indexHtml).toContain('<title>Clinical Portal</title>');
    });

    it('should create patient routes', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/src/routes/index.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/routes/patients/$patientId.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/routes/patients/$patientId/index.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/routes/patients/$patientId/conditions.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/routes/patients/$patientId/medications.tsx')).toBe(true);
    });

    it('should not include browser-specific files', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/src/components/data-table')).toBe(false);
      expect(tree.exists('test-clinical/src/components/command-palette.tsx')).toBe(false);
      expect(tree.exists('test-clinical/src/routes/resources')).toBe(false);
      expect(tree.exists('test-clinical/src/lib/fhir-columns.tsx')).toBe(false);
      expect(tree.exists('test-clinical/src/lib/resource-icons.ts')).toBe(false);
    });

    it('should include clinical-specific hooks and components', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/src/hooks/use-clinical-api.ts')).toBe(true);
      expect(tree.exists('test-clinical/src/components/patient-search.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/patient-header.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/clinical-table.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/lib/clinical-formatters.ts')).toBe(true);
    });

    it('should not include browser-only dependencies', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const packageJson = readJson(tree, 'test-clinical/package.json');
      expect(packageJson.dependencies['@tanstack/react-virtual']).toBeUndefined();
      expect(packageJson.dependencies['cmdk']).toBeUndefined();
      expect(packageJson.dependencies['nuqs']).toBeUndefined();
    });

    it('should include shared dependencies', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const packageJson = readJson(tree, 'test-clinical/package.json');
      expect(packageJson.dependencies['@tanstack/react-router']).toBeDefined();
      expect(packageJson.dependencies['@tanstack/react-query']).toBeDefined();
      expect(packageJson.dependencies['@tanstack/react-table']).toBeDefined();
      expect(packageJson.dependencies['react']).toBeDefined();
      expect(packageJson.dependencies['tailwindcss']).toBeDefined();
    });

    it('should include shared UI components', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/src/components/ui/button.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/ui/card.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/ui/badge.tsx')).toBe(true);
    });

    it('should include shared config and build files', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/vite.config.ts')).toBe(true);
      expect(tree.exists('test-clinical/vitest.config.ts')).toBe(true);
      expect(tree.exists('test-clinical/biome.json')).toBe(true);
      expect(tree.exists('test-clinical/tsconfig.json')).toBe(true);
    });

    it('should default to sidebar navigation layout', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const config = readProjectConfiguration(tree, 'test-clinical');
      expect((config as FrontendProjectConfiguration).navigationLayout).toBe('sidebar');
      expect(tree.exists('test-clinical/src/components/app-sidebar.tsx')).toBe(true);
      expect(tree.exists('test-clinical/src/components/ui/sidebar.tsx')).toBe(true);
    });

    it('should not include variant files in output', async () => {
      await frontendGenerator(tree, clinicalOptions);
      expect(tree.exists('test-clinical/_variants')).toBe(false);
    });

    describe('topnav navigation layout', () => {
      const topnavOptions: FrontendGeneratorSchema = {
        name: 'test-topnav',
        template: 'clinical',
        navigationLayout: 'topnav',
      };

      it('should store navigationLayout in project config', async () => {
        await frontendGenerator(tree, topnavOptions);
        const config = readProjectConfiguration(tree, 'test-topnav');
        expect((config as FrontendProjectConfiguration).navigationLayout).toBe('topnav');
      });

      it('should create __root.tsx with top navigation', async () => {
        await frontendGenerator(tree, topnavOptions);
        expect(tree.exists('test-topnav/src/routes/__root.tsx')).toBe(true);
        const root = tree.read('test-topnav/src/routes/__root.tsx', 'utf-8');
        expect(root).not.toContain('SidebarProvider');
        expect(root).not.toContain('AppSidebar');
      });

      it('should not include sidebar components', async () => {
        await frontendGenerator(tree, topnavOptions);
        expect(tree.exists('test-topnav/src/components/app-sidebar.tsx')).toBe(false);
        expect(tree.exists('test-topnav/src/components/ui/sidebar.tsx')).toBe(false);
        expect(tree.exists('test-topnav/src/components/ui/sheet.tsx')).toBe(false);
      });

      it('should use the layout the user picks when none is given', async () => {
        select.mockResolvedValue('topnav');

        await frontendGenerator(tree, {
          name: 'test-prompted',
          template: 'clinical',
        });

        expect(select).toHaveBeenCalledTimes(1);
        const config = readProjectConfiguration(tree, 'test-prompted');
        expect((config as FrontendProjectConfiguration).navigationLayout).toBe(
          'topnav',
        );
        const root = tree.read('test-prompted/src/routes/__root.tsx', 'utf-8');
        expect(root).not.toContain('SidebarProvider');
      });

      it('should still include clinical-specific components', async () => {
        await frontendGenerator(tree, topnavOptions);
        expect(tree.exists('test-topnav/src/components/patient-search.tsx')).toBe(true);
        expect(tree.exists('test-topnav/src/components/patient-header.tsx')).toBe(true);
        expect(tree.exists('test-topnav/src/components/clinical-table.tsx')).toBe(true);
      });
    });
  });
});
