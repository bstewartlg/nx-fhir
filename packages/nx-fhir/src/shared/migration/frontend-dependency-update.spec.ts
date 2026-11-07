import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { logger, readJson, Tree, updateJson, writeJson } from '@nx/devkit';
import { join } from 'path';
import { CheckResult } from './project-checks';

const runCommand = vi.hoisted(() => vi.fn());
const runProjectChecks = vi.hoisted(() => vi.fn());
const createVerificationCopy = vi.hoisted(() => vi.fn());
const installDependencies = vi.hoisted(() => vi.fn());
const isInteractive = vi.hoisted(() => vi.fn(() => false));
const isDryRun = vi.hoisted(() => vi.fn(() => false));
const select = vi.hoisted(() => vi.fn());
const findInstalledVersion = vi.hoisted(() => vi.fn());
const readCopyFile = vi.hoisted(() => vi.fn());
const dispose = vi.hoisted(() => vi.fn());
const hasModules = vi.hoisted(() => ({ root: true, project: true }));

vi.mock('./project-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./project-checks')>()),
  runCommand,
  runProjectChecks,
}));
vi.mock('./verification-copy', () => ({ createVerificationCopy }));
vi.mock('./install-dependencies', () => ({ installDependencies }));
vi.mock('../utils/interactive', () => ({ isInteractive }));
vi.mock('../utils/dry-run', () => ({ isDryRun }));
vi.mock('@inquirer/prompts', () => ({ select }));
vi.mock('./dependency-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dependency-policy')>()),
  findInstalledVersion,
}));
vi.mock('@nx/devkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nx/devkit')>();
  return {
    ...actual,
    detectPackageManager: () => 'bun',
    logger: { ...actual.logger, info: vi.fn(), warn: vi.fn() },
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  // The tree root has no directory on disk, so the installed module trees
  // the baseline looks for are reported from the flags above
  // The paths are built with join so the comparison matches the code under
  // test on Windows, where join uses backslashes
  const { join: joinPath } = await import('path');
  const rootModules = joinPath('/virtual', 'node_modules');
  const projectModules = joinPath('/virtual', 'frontend', 'node_modules');
  const existsSync = (target: unknown) => {
    const path = String(target);
    if (path === rootModules) {
      return hasModules.root;
    }
    if (path === projectModules) {
      return hasModules.project;
    }
    return actual.existsSync(path);
  };
  const mocked = { ...actual, existsSync };
  return { ...mocked, default: mocked };
});

import {
  decideUpdate,
  planDependencyChanges,
  updateFrontendDependencies,
} from './frontend-dependency-update';
import { DependencyChange, OUT_OF_RANGE_NOTE } from './dependency-policy';

const projectName = 'frontend';
const projectRoot = 'frontend';

const routine: DependencyChange = {
  name: 'vite',
  section: 'devDependencies',
  from: '^8.0.0',
  to: '^8.3.5',
  kind: 'routine',
};
const risky: DependencyChange = {
  name: 'react',
  section: 'dependencies',
  from: '^18.0.0',
  to: '^19.2.0',
  kind: 'risky',
  reason: OUT_OF_RANGE_NOTE,
};
const added: DependencyChange = {
  name: 'zod',
  section: 'dependencies',
  to: '^4.1.0',
  kind: 'added',
};
const ahead: DependencyChange = {
  name: 'typescript',
  section: 'devDependencies',
  from: '^7.0.2',
  to: '^7.0.2',
  kind: 'ahead',
};
const sameFloor: DependencyChange = {
  name: '@testing-library/jest-dom',
  section: 'devDependencies',
  from: '^6.9.1',
  to: '^6.9.1',
  kind: 'unchanged',
  reason: 'kept your range',
};
const unmanaged: DependencyChange = {
  name: 'react-dom',
  section: 'dependencies',
  from: 'workspace:*',
  to: 'workspace:*',
  kind: 'unmanaged',
};

const passing = (script: string): CheckResult => ({
  script,
  passed: true,
  output: '',
});
const failing = (script: string, output = `${script} broke`): CheckResult => ({
  script,
  passed: false,
  output,
});

function createWorkspace(
  packageJson: Record<string, unknown> = {
    name: projectName,
    scripts: { build: 'vite build', check: 'biome check', test: 'vitest run' },
    dependencies: { react: '^18.0.0' },
    devDependencies: { vite: '^8.0.0' },
  },
): Tree {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, `${projectRoot}/package.json`, packageJson);
  return tree;
}

function update(
  tree: Tree,
  changes: DependencyChange[],
  overrides: Partial<{ hasConflicts: boolean; acceptBreaking: boolean }> = {},
) {
  return updateFrontendDependencies({
    tree,
    projectName,
    projectRoot,
    changes,
    hasConflicts: false,
    acceptBreaking: false,
    ...overrides,
  });
}

/** Checks pass everywhere except the named scripts in the named directory */
function checksFailingIn(dir: string, scripts: string[]) {
  runProjectChecks.mockImplementation(
    async (cwd: string, _pm: string, defined: Record<string, string>) =>
      ['build', 'check', 'test']
        .filter((script) => defined?.[script])
        .map((script) =>
          cwd === dir && scripts.includes(script)
            ? failing(script)
            : passing(script),
        ),
  );
}

const infoLines = () =>
  (logger.info as ReturnType<typeof vi.fn>).mock.calls.map(([line]) =>
    String(line),
  );

describe('decideUpdate', () => {
  const decide = (
    overrides: Partial<Parameters<typeof decideUpdate>[0]> = {},
  ) =>
    decideUpdate({
      riskyCount: 0,
      newFailureCount: 0,
      hasConflicts: false,
      acceptBreaking: false,
      interactive: true,
      ...overrides,
    });

  it('keeps without a question when nothing is risky, failing, or conflicted', () => {
    expect(decide({ interactive: false })).toEqual({
      decision: 'keep',
      reason: 'no-question',
    });
  });

  it('keeps when the accept flag is set', () => {
    expect(
      decide({ riskyCount: 3, newFailureCount: 2, acceptBreaking: true }),
    ).toEqual({ decision: 'keep', reason: 'flag' });
  });

  it('undoes without a terminal', () => {
    expect(decide({ riskyCount: 1, interactive: false })).toEqual({
      decision: 'undo',
      reason: 'no-terminal',
    });
  });

  it('asks with keep as the default when nothing new fails', () => {
    expect(decide({ riskyCount: 1 })).toEqual({
      decision: 'ask',
      defaultAnswer: 'keep',
      reason: 'user',
    });
  });

  it('asks with undo as the default when something new fails', () => {
    expect(decide({ newFailureCount: 1 })).toEqual({
      decision: 'ask',
      defaultAnswer: 'undo',
      reason: 'user',
    });
  });

  it('asks about conflicts even with no risky changes', () => {
    expect(decide({ hasConflicts: true })).toEqual({
      decision: 'ask',
      defaultAnswer: 'keep',
      reason: 'user',
    });
  });
});

describe('planDependencyChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findInstalledVersion.mockReturnValue(undefined);
  });

  it('classifies the project package.json against the template', () => {
    const tree = createWorkspace({
      name: projectName,
      devDependencies: { '@biomejs/biome': '^2.4.5' },
    });
    findInstalledVersion.mockImplementation((_start, _stop, name) =>
      name === '@biomejs/biome' ? '2.4.5' : undefined,
    );
    const changesBefore = tree.listChanges();

    const changes = planDependencyChanges(tree, projectRoot, 'browser');

    expect(tree.listChanges()).toEqual(changesBefore);
    expect(findInstalledVersion).toHaveBeenCalledWith(
      join(tree.root, projectRoot),
      tree.root,
      '@biomejs/biome',
    );
    expect(changes.find((c) => c.name === '@biomejs/biome')).toMatchObject({
      kind: 'risky',
      from: '^2.4.5',
      to: '2.6.4',
      advisory: expect.objectContaining({ packageName: '@biomejs/biome' }),
    });
    expect(changes.filter((c) => c.kind === 'added').length).toBeGreaterThan(0);
  });
});

describe('updateFrontendDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isInteractive.mockReturnValue(false);
    isDryRun.mockReturnValue(false);
    hasModules.root = true;
    hasModules.project = true;
    findInstalledVersion.mockReturnValue(undefined);
    runCommand.mockResolvedValue({ passed: true, output: '' });
    checksFailingIn('', []);
    readCopyFile.mockReturnValue(null);
    createVerificationCopy.mockReturnValue({
      dir: '/copy',
      readFile: readCopyFile,
      dispose,
    });
    installDependencies.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the chosen changes through addDependenciesToPackageJson', async () => {
    const tree = createWorkspace({
      name: projectName,
      dependencies: { react: '^18.0.0', 'react-dom': 'workspace:*' },
      devDependencies: { vite: '^8.0.0', typescript: '^7.0.2' },
    });

    await update(tree, [routine, risky, added, ahead, unmanaged], {
      acceptBreaking: true,
    });

    const packageJson = readJson(tree, `${projectRoot}/package.json`);
    expect(packageJson.dependencies).toEqual({
      react: '^19.2.0',
      'react-dom': 'workspace:*',
      zod: '^4.1.0',
    });
    expect(packageJson.devDependencies).toEqual({
      vite: '^8.3.5',
      typescript: '^7.0.2',
    });
    expect(installDependencies).toHaveBeenCalledWith(
      tree,
      projectRoot,
      packageJson,
    );
  });

  it('keeps routine changes without a question, checking in the copy first', async () => {
    const tree = createWorkspace();

    await expect(update(tree, [routine])).resolves.toBe('kept');

    expect(runProjectChecks).toHaveBeenNthCalledWith(
      1,
      join(tree.root, projectRoot),
      'bun',
      expect.objectContaining({ build: 'vite build' }),
    );
    expect(runCommand).toHaveBeenCalledWith('bun install', '/copy');
    expect(runProjectChecks).toHaveBeenNthCalledWith(
      2,
      '/copy',
      'bun',
      expect.objectContaining({ build: 'vite build' }),
    );
    const order = [
      runProjectChecks.mock.invocationCallOrder[0],
      createVerificationCopy.mock.invocationCallOrder[0],
      runCommand.mock.invocationCallOrder[0],
      runProjectChecks.mock.invocationCallOrder[1],
      installDependencies.mock.invocationCallOrder[0],
      dispose.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(select).not.toHaveBeenCalled();
  });

  it('runs the fix in the copy and brings its files into the tree with the accept flag', async () => {
    const tree = createWorkspace({
      name: projectName,
      devDependencies: { '@biomejs/biome': '^2.4.5' },
    });
    findInstalledVersion.mockImplementation((_start, _stop, name) =>
      name === '@biomejs/biome' ? '2.4.5' : undefined,
    );
    const migrated = Buffer.from('{ "migrated": true }\n');
    const migratedJsonc = Buffer.from('// migrated\n{}\n');
    readCopyFile.mockImplementation((file: string) =>
      file === 'biome.json' ? migrated : file === 'biome.jsonc' ? migratedJsonc : null,
    );
    const changes = planDependencyChanges(tree, projectRoot, 'browser');

    await expect(
      update(tree, changes, { acceptBreaking: true }),
    ).resolves.toBe('kept');

    expect(runCommand).toHaveBeenCalledWith('bunx biome migrate --write', '/copy');
    expect(tree.read(`${projectRoot}/biome.json`)).toEqual(migrated);
    expect(tree.read(`${projectRoot}/biome.jsonc`)).toEqual(migratedJsonc);
    expect(select).not.toHaveBeenCalled();
  });

  it('empties the tree and returns normally when the user picks undo', async () => {
    const tree = createWorkspace();
    isInteractive.mockReturnValue(true);
    checksFailingIn('/copy', ['test']);
    select.mockResolvedValue('undo');

    await expect(update(tree, [routine])).resolves.toBe('undone');

    expect(tree.listChanges()).toEqual([]);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ default: 'undo' }),
    );
    expect(infoLines()).toContain('  test: baseline passed, after update failed');
    expect(infoLines().some((line) => /test: new failure/.test(line))).toBe(true);
    expect(dispose).toHaveBeenCalled();
    expect(installDependencies).not.toHaveBeenCalled();
    expect(infoLines().some((line) => /Skip/.test(line))).toBe(true);
  });

  it('keeps a broken update when the user picks keep', async () => {
    const tree = createWorkspace();
    isInteractive.mockReturnValue(true);
    checksFailingIn('/copy', ['test']);
    select.mockResolvedValue('keep');

    await expect(update(tree, [routine])).resolves.toBe('kept');

    expect(installDependencies).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
  });

  it('removes the copy and rethrows when the prompt is cancelled', async () => {
    const tree = createWorkspace();
    isInteractive.mockReturnValue(true);
    const cancelled = Object.assign(new Error('User force closed the prompt'), {
      name: 'ExitPromptError',
    });
    select.mockRejectedValue(cancelled);

    await expect(update(tree, [risky])).rejects.toBe(cancelled);

    expect(dispose).toHaveBeenCalled();
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it('counts an install failure in the copy as a new failure', async () => {
    const tree = createWorkspace({
      name: projectName,
      scripts: { build: 'vite build' },
      devDependencies: { '@biomejs/biome': '^2.4.5' },
    });
    isInteractive.mockReturnValue(true);
    findInstalledVersion.mockReturnValue('2.4.5');
    runCommand.mockResolvedValue({ passed: false, output: 'ERESOLVE' });
    select.mockResolvedValue('keep');
    const changes = planDependencyChanges(tree, projectRoot, 'browser');

    await update(tree, changes);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runProjectChecks).not.toHaveBeenCalledWith(
      '/copy',
      expect.anything(),
      expect.anything(),
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ default: 'undo' }),
    );
    expect(infoLines().some((line) => /install.*ERESOLVE/s.test(line))).toBe(
      true,
    );
  });

  it('keeps the baseline lines when the copy install fails', async () => {
    const tree = createWorkspace();
    runCommand.mockResolvedValue({ passed: false, output: 'ERESOLVE' });

    await update(tree, [routine], { acceptBreaking: true });

    expect(runProjectChecks).toHaveBeenCalledTimes(1);
    const lines = infoLines();
    expect(lines).toContain('  build: baseline passed, after update skipped');
    expect(lines).toContain('  check: baseline passed, after update skipped');
    expect(lines).toContain('  test: baseline passed, after update skipped');
    expect(lines).toContain('  install: no baseline, after update failed');
    expect(lines.some((line) => /install: new failure\nERESOLVE/.test(line))).toBe(true);
    expect(lines.some((line) => /workspace: ranges/.test(line))).toBe(false);
  });

  it('continues to the checks when a fix command fails', async () => {
    const tree = createWorkspace({
      name: projectName,
      scripts: { build: 'vite build' },
      devDependencies: { '@biomejs/biome': '^2.4.5' },
    });
    findInstalledVersion.mockReturnValue('2.4.5');
    runCommand.mockImplementation(async (command: string) =>
      command.startsWith('bunx')
        ? { passed: false, output: 'unknown command' }
        : { passed: true, output: '' },
    );
    const changes = planDependencyChanges(tree, projectRoot, 'browser');

    await update(tree, changes, { acceptBreaking: true });

    expect(runProjectChecks).toHaveBeenCalledWith(
      '/copy',
      'bun',
      expect.anything(),
    );
    expect(
      infoLines().some((line) => /biome migrate --write.*failed/s.test(line)),
    ).toBe(true);
  });

  it('brings a fix file into the tree even when the fix command failed', async () => {
    const tree = createWorkspace({
      name: projectName,
      scripts: { build: 'vite build' },
      devDependencies: { '@biomejs/biome': '^2.4.5' },
    });
    findInstalledVersion.mockReturnValue('2.4.5');
    const edited = Buffer.from('{ "edited": true }\n');
    runCommand.mockImplementation(async (command: string) => {
      if (!command.startsWith('bunx')) {
        return { passed: true, output: '' };
      }
      readCopyFile.mockImplementation((file: string) =>
        file === 'biome.json' ? edited : null,
      );
      return { passed: false, output: 'exit 1 after writing' };
    });
    const changes = planDependencyChanges(tree, projectRoot, 'browser');

    await expect(
      update(tree, changes, { acceptBreaking: true }),
    ).resolves.toBe('kept');

    expect(tree.read(`${projectRoot}/biome.json`)).toEqual(edited);
    expect(
      infoLines().some((line) => /biome migrate --write.*failed/s.test(line)),
    ).toBe(true);
  });

  it('reports no baseline when a standalone project has no installed modules', async () => {
    const tree = createWorkspace();
    hasModules.root = true;
    hasModules.project = false;

    await expect(update(tree, [routine])).resolves.toBe('kept');

    expect(runProjectChecks).toHaveBeenCalledTimes(1);
    expect(runProjectChecks).toHaveBeenCalledWith('/copy', 'bun', expect.anything());
    expect(infoLines()).toContain('  build: no baseline, after update passed');
  });

  it('runs the baseline from the root modules for a workspace member', async () => {
    const tree = createWorkspace();
    updateJson(tree, 'package.json', (json) => ({
      ...json,
      workspaces: [projectRoot],
    }));
    hasModules.root = true;
    hasModules.project = false;

    await expect(update(tree, [routine])).resolves.toBe('kept');

    expect(runProjectChecks).toHaveBeenCalledTimes(2);
    expect(runProjectChecks).toHaveBeenNthCalledWith(
      1,
      join(tree.root, projectRoot),
      'bun',
      expect.anything(),
    );
    expect(infoLines()).toContain('  build: baseline passed, after update passed');
  });

  it('names workspace ranges as the likely cause of a failed copy install', async () => {
    const tree = createWorkspace({
      name: projectName,
      scripts: { build: 'vite build' },
      dependencies: { react: '^18.0.0', 'react-dom': 'workspace:*' },
    });
    runCommand.mockResolvedValue({ passed: false, output: 'ERESOLVE' });

    await update(tree, [routine, unmanaged], { acceptBreaking: true });

    expect(
      infoLines().some((line) =>
        /install: new failure\nERESOLVE\n.*workspace: ranges/.test(line),
      ),
    ).toBe(true);
  });

  it('removes the copy when the real install fails', async () => {
    const tree = createWorkspace();
    const failure = new Error('install failed');
    installDependencies.mockRejectedValue(failure);

    await expect(update(tree, [routine])).rejects.toBe(failure);

    expect(dispose).toHaveBeenCalled();
  });

  it('reports a script that failed before the update as already failing', async () => {
    const tree = createWorkspace();
    isInteractive.mockReturnValue(true);
    runProjectChecks.mockImplementation(async () => [
      passing('build'),
      failing('check'),
      passing('test'),
    ]);

    await expect(update(tree, [routine])).resolves.toBe('kept');

    expect(select).not.toHaveBeenCalled();
    expect(infoLines()).toContain('  check: baseline failed, after update failed');
    expect(
      infoLines().some((line) => /check: already failing before the update.*\ncheck broke/.test(line)),
    ).toBe(true);
  });

  it('skips the checks and the copy when the merge has conflicts', async () => {
    const tree = createWorkspace({
      name: projectName,
      scripts: { build: 'vite build' },
      devDependencies: { '@biomejs/biome': '^2.4.5' },
    });
    isInteractive.mockReturnValue(true);
    findInstalledVersion.mockReturnValue('2.4.5');
    select.mockResolvedValue('keep');
    const changes = planDependencyChanges(tree, projectRoot, 'browser');

    await expect(
      update(tree, changes, { hasConflicts: true }),
    ).resolves.toBe('kept');

    expect(runProjectChecks).not.toHaveBeenCalled();
    expect(createVerificationCopy).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(installDependencies).toHaveBeenCalled();
    expect(
      infoLines().some((line) => /bunx biome migrate --write/.test(line)),
    ).toBe(true);
  });

  it('undoes on conflicts without a terminal or the flag', async () => {
    const tree = createWorkspace();

    await expect(
      update(tree, [routine], { hasConflicts: true }),
    ).resolves.toBe('undone');

    expect(tree.listChanges()).toEqual([]);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it('prints the classification and changes nothing on a dry run', async () => {
    const tree = createWorkspace();
    isDryRun.mockReturnValue(true);

    await expect(update(tree, [routine, risky])).resolves.toBe('dry-run');

    expect(runCommand).not.toHaveBeenCalled();
    expect(runProjectChecks).not.toHaveBeenCalled();
    expect(createVerificationCopy).not.toHaveBeenCalled();
    expect(installDependencies).not.toHaveBeenCalled();
    expect(infoLines().some((line) => /vite: \^8\.0\.0 -> \^8\.3\.5/.test(line))).toBe(
      true,
    );
  });

  it('skips the copy when the project has no check scripts and no fix applies', async () => {
    const tree = createWorkspace({
      name: projectName,
      devDependencies: { vite: '^8.0.0' },
    });

    await expect(update(tree, [routine])).resolves.toBe('kept');

    expect(runProjectChecks).not.toHaveBeenCalled();
    expect(createVerificationCopy).not.toHaveBeenCalled();
    expect(installDependencies).toHaveBeenCalled();
  });

  it('prints every dependency change in the report', async () => {
    const tree = createWorkspace({
      name: projectName,
      scripts: { build: 'vite build', check: 'biome check', test: 'vitest run' },
      dependencies: { react: '^18.0.0', 'react-dom': 'workspace:*' },
      devDependencies: { vite: '^8.0.0', typescript: '^7.0.2' },
    });

    await update(tree, [routine, risky, added, ahead, unmanaged, sameFloor], {
      acceptBreaking: true,
    });

    const lines = infoLines().join('\n');
    expect(lines).toContain('build: baseline passed, after update passed');
    expect(lines).toContain('check: baseline passed, after update passed');
    expect(lines).toContain('test: baseline passed, after update passed');
    expect(lines).toContain('@testing-library/jest-dom: kept your range ^6.9.1');
    expect(lines).toContain('vite: ^8.0.0 -> ^8.3.5');
    expect(lines).toContain('react: ^18.0.0 -> ^19.2.0');
    expect(lines).toContain(OUT_OF_RANGE_NOTE);
    expect(lines).toMatch(/zod: .*\^4\.1\.0/);
    expect(lines).toMatch(/typescript: .*\^7\.0\.2/);
    expect(lines).toMatch(/react-dom: .*workspace:\*/);
  });
});
