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
});
