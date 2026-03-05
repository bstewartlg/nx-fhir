import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, readProjectConfiguration, readJson } from '@nx/devkit';

import { frontendGenerator } from './frontend';
import { FrontendGeneratorSchema } from './schema';

describe('frontend generator', () => {
  let tree: Tree;
  const options: FrontendGeneratorSchema = { name: 'test-frontend' };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('should create project configuration', async () => {
    await frontendGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'test-frontend');
    expect(config).toBeDefined();
    expect(config.root).toBe('test-frontend');
    expect(config.projectType).toBe('application');
    expect(config.tags).toContain('nx-fhir-frontend');
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
    expect((config as any).frontendVersion).toBeDefined();
    expect((config as any).pluginVersion).toBeDefined();
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
    expect((config as any).frontendTemplate).toBe('browser');
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
    expect(packageJson.dependencies['nuqs']).toBeDefined();
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
      expect((config as any).frontendTemplate).toBe('clinical');
      expect((config as any).frontendVersion).toBeDefined();
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
      expect(tree.exists('test-clinical/src/components/json-viewer-dialog.tsx')).toBe(false);
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

    it('should not include Monaco editor in dependencies', async () => {
      await frontendGenerator(tree, clinicalOptions);
      const packageJson = readJson(tree, 'test-clinical/package.json');
      expect(packageJson.dependencies['@monaco-editor/react']).toBeUndefined();
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
      expect((config as any).navigationLayout).toBe('sidebar');
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
        expect((config as any).navigationLayout).toBe('topnav');
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

      it('should still include clinical-specific components', async () => {
        await frontendGenerator(tree, topnavOptions);
        expect(tree.exists('test-topnav/src/components/patient-search.tsx')).toBe(true);
        expect(tree.exists('test-topnav/src/components/patient-header.tsx')).toBe(true);
        expect(tree.exists('test-topnav/src/components/clinical-table.tsx')).toBe(true);
      });
    });
  });
});
