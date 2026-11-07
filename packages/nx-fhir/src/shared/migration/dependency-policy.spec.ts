import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEPENDENCY_ADVISORIES } from './dependency-advisories';
import {
  OUT_OF_RANGE_NOTE,
  classifyDependencies,
  findInstalledVersion,
} from './dependency-policy';

const BIOME_ADVISORY = DEPENDENCY_ADVISORIES.find(
  (advisory) => advisory.packageName === '@biomejs/biome',
);

function classifyOne(
  name: string,
  templateRange: string,
  projectRange?: string,
  installed?: string,
) {
  const changes = classifyDependencies(
    { dependencies: {}, devDependencies: { [name]: templateRange } },
    { devDependencies: projectRange ? { [name]: projectRange } : {} },
    (packageName) => (packageName === name ? installed : undefined),
    DEPENDENCY_ADVISORIES,
  );
  expect(changes).toHaveLength(1);
  return changes[0];
}

function classifyMovedVite() {
  return classifyDependencies(
    { dependencies: {}, devDependencies: { vite: '^8.3.5' } },
    { dependencies: { vite: '^8.0.0' } },
    () => undefined,
    DEPENDENCY_ADVISORIES,
  );
}

describe('classifyDependencies', () => {
  it('adds a package the project lacks', () => {
    expect(classifyOne('vite', '^8.3.5')).toMatchObject({
      kind: 'added',
      to: '^8.3.5',
      section: 'devDependencies',
    });
  });

  it('leaves an equal range alone', () => {
    expect(classifyOne('vite', '^8.3.5', '^8.3.5')).toMatchObject({
      kind: 'unchanged',
      to: '^8.3.5',
    });
  });

  it('keeps a range whose floor equals the template floor', () => {
    expect(
      classifyOne('@testing-library/jest-dom', '~6.9.1', '^6.9.1'),
    ).toMatchObject({
      kind: 'unchanged',
      from: '^6.9.1',
      to: '^6.9.1',
      reason: 'kept your range',
    });
  });

  it('keeps a range that is not semver', () => {
    expect(classifyOne('vite', '^8.3.5', 'workspace:*')).toMatchObject({
      kind: 'unmanaged',
      to: 'workspace:*',
    });
  });

  it('keeps a range that no version satisfies', () => {
    expect(classifyOne('vite', '^8.3.5', '>9.0.0 <8.0.0')).toMatchObject({
      kind: 'unmanaged',
      to: '>9.0.0 <8.0.0',
    });
  });

  it('keeps a project floor above the template floor', () => {
    expect(classifyOne('typescript', '~6.0.3', '^7.0.2')).toMatchObject({
      kind: 'ahead',
      to: '^7.0.2',
    });
  });

  it('keeps an installed version the template range cannot reach', () => {
    expect(
      classifyOne('@testing-library/jest-dom', '~6.9.1', '^6.9.1', '6.10.0'),
    ).toMatchObject({ kind: 'ahead', to: '^6.9.1' });
  });

  it('applies an in-range floor', () => {
    expect(classifyOne('vite', '^8.3.5', '^8.0.0', '8.1.0')).toMatchObject({
      kind: 'routine',
      from: '^8.0.0',
      to: '^8.3.5',
    });
  });

  it('marks a major outside the range', () => {
    const change = classifyOne('vite', '^8.3.5', '^7.1.0');
    expect(change).toMatchObject({
      kind: 'risky',
      to: '^8.3.5',
      reason: OUT_OF_RANGE_NOTE,
    });
    expect(change.advisory).toBeUndefined();
  });

  it('marks a 0.x step outside the range', () => {
    expect(classifyOne('@types/fhir', '^0.0.44', '^0.0.41')).toMatchObject({
      kind: 'risky',
      to: '^0.0.44',
    });
  });

  it('marks an in-range change that crosses an advisory boundary', () => {
    expect(BIOME_ADVISORY).toBeDefined();
    const change = classifyOne('@biomejs/biome', '2.6.4', '^2.4.5', '2.4.5');
    expect(change).toMatchObject({ kind: 'risky', to: '2.6.4' });
    expect(change.reason).toBe(BIOME_ADVISORY?.note);
    expect(change.advisory).toBe(BIOME_ADVISORY);
  });

  it('skips the advisory when the installed version is past the boundary', () => {
    const change = classifyOne('@biomejs/biome', '2.6.4', '^2.4.5', '2.6.1');
    expect(change).toMatchObject({ kind: 'routine', to: '2.6.4' });
    expect(change.advisory).toBeUndefined();
  });

  it('finds the package in the other section', () => {
    expect(classifyMovedVite()).toEqual([
      {
        name: 'vite',
        section: 'dependencies',
        from: '^8.0.0',
        to: '^8.3.5',
        kind: 'routine',
      },
    ]);
  });
});

describe('findInstalledVersion', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createWorkspace() {
    const root = mkdtempSync(join(tmpdir(), 'nx-fhir-installed-'));
    tempDirs.push(root);
    const project = join(root, 'apps', 'web');
    mkdirSync(project, { recursive: true });
    return { root, project };
  }

  function install(dir: string, packageName: string, version: string) {
    const packageDir = join(dir, 'node_modules', packageName);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: packageName, version }),
    );
  }

  it('reads the version from the project node_modules', () => {
    const { root, project } = createWorkspace();
    install(root, '@biomejs/biome', '2.4.5');
    install(project, '@biomejs/biome', '2.6.1');

    expect(findInstalledVersion(project, root, '@biomejs/biome')).toBe('2.6.1');
  });

  it('finds a package hoisted to a parent directory', () => {
    const { root, project } = createWorkspace();
    install(root, 'vite', '8.1.0');

    expect(findInstalledVersion(project, root, 'vite')).toBe('8.1.0');
  });

  it('stops at the stop directory', () => {
    const { root, project } = createWorkspace();
    install(root, 'vite', '8.1.0');

    expect(
      findInstalledVersion(project, join(root, 'apps'), 'vite'),
    ).toBeUndefined();
  });

  it('returns undefined when the package is not installed', () => {
    const { root, project } = createWorkspace();

    expect(findInstalledVersion(project, root, 'vite')).toBeUndefined();
  });
});
