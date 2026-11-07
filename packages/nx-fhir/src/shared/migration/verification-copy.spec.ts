import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileChange, Tree } from '@nx/devkit';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createVerificationCopy, VerificationCopy } from './verification-copy';

const projectRoot = 'frontend';
const packageJson = { name: 'frontend', dependencies: { react: '^19.0.0' } };

describe('createVerificationCopy', () => {
  let workspaceRoot: string;
  let copies: VerificationCopy[];

  const writeWorkspaceFile = (relativePath: string, content: string) => {
    const full = join(workspaceRoot, ...relativePath.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  const createCopy = (changes: FileChange[] = []) => {
    const tree = { root: workspaceRoot, listChanges: () => changes } as Tree;
    const copy = createVerificationCopy({ tree, projectRoot, packageJson });
    copies.push(copy);
    return copy;
  };

  const copyHas = (copy: VerificationCopy, relativePath: string) =>
    existsSync(join(copy.dir, ...relativePath.split('/')));

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-fhir-verify-spec-'));
    copies = [];
    writeWorkspaceFile('frontend/package.json', '{"name":"stale"}\n');
    writeWorkspaceFile('frontend/src/a.ts', 'export const a = 1;\n');
  });

  afterEach(() => {
    for (const copy of copies) {
      copy.dispose();
    }
    rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  it('copies the frontend folder without node_modules', () => {
    writeWorkspaceFile('frontend/node_modules/x/index.js', 'module.exports = 1;\n');

    const copy = createCopy();

    expect(copy.dir.startsWith(join(tmpdir(), 'nx-fhir-verify-'))).toBe(true);
    expect(copyHas(copy, 'src/a.ts')).toBe(true);
    expect(copyHas(copy, 'node_modules')).toBe(false);
  });

  it('applies the pending tree changes under the project root', () => {
    writeWorkspaceFile('frontend/src/removed.ts', 'gone\n');

    const copy = createCopy([
      { path: 'frontend/src/a.ts', type: 'UPDATE', content: Buffer.from('updated\n') },
      { path: 'frontend/src/added.ts', type: 'CREATE', content: Buffer.from('added\n') },
      { path: 'frontend/src/removed.ts', type: 'DELETE', content: null },
      { path: 'other/src/b.ts', type: 'CREATE', content: Buffer.from('elsewhere\n') },
      { path: 'frontend-two/src/c.ts', type: 'CREATE', content: Buffer.from('sibling\n') },
    ]);

    expect(copy.readFile('src/a.ts')?.toString()).toBe('updated\n');
    expect(copy.readFile('src/added.ts')?.toString()).toBe('added\n');
    expect(copyHas(copy, 'src/removed.ts')).toBe(false);
    expect(copyHas(copy, 'src/b.ts')).toBe(false);
    expect(copyHas(copy, 'src/c.ts')).toBe(false);
  });

  it('removes a directory the tree lists as deleted', () => {
    writeWorkspaceFile('frontend/src/old/only.ts', 'gone\n');

    const copy = createCopy([
      { path: 'frontend/src/old/only.ts', type: 'DELETE', content: null },
      { path: 'frontend/src/old', type: 'DELETE', content: null },
    ]);

    expect(copyHas(copy, 'src/old')).toBe(false);
    expect(copyHas(copy, 'src/a.ts')).toBe(true);
  });

  it('removes lockfiles and writes the new package.json', () => {
    writeWorkspaceFile('frontend/bun.lock', 'lock\n');
    writeWorkspaceFile('frontend/bun.lockb', 'lock\n');
    writeWorkspaceFile('frontend/package-lock.json', '{}\n');

    const copy = createCopy();

    expect(copyHas(copy, 'bun.lock')).toBe(false);
    expect(copyHas(copy, 'bun.lockb')).toBe(false);
    expect(copyHas(copy, 'package-lock.json')).toBe(false);
    expect(copy.readFile('package.json')?.toString()).toBe(
      JSON.stringify(packageJson, null, 2) + '\n'
    );
  });

  it('writes the given package.json over a pending tree change to it', () => {
    const copy = createCopy([
      {
        path: 'frontend/package.json',
        type: 'UPDATE',
        content: Buffer.from('{"name":"from-tree"}\n'),
      },
    ]);

    expect(JSON.parse(copy.readFile('package.json')?.toString() ?? '')).toEqual(
      packageJson
    );
  });

  it('copies the workspace registry files when the project has none', () => {
    writeWorkspaceFile('.npmrc', 'registry=https://example.invalid/\n');
    writeWorkspaceFile('bunfig.toml', '[install]\n');

    const copy = createCopy();

    expect(copy.readFile('.npmrc')?.toString()).toBe(
      'registry=https://example.invalid/\n'
    );
    expect(copy.readFile('bunfig.toml')?.toString()).toBe('[install]\n');
  });

  it("keeps the project's own registry file over the workspace one", () => {
    writeWorkspaceFile('.npmrc', 'workspace\n');
    writeWorkspaceFile('frontend/.npmrc', 'project\n');

    const copy = createCopy();

    expect(copy.readFile('.npmrc')?.toString()).toBe('project\n');
    expect(copyHas(copy, 'bunfig.toml')).toBe(false);
  });

  it('reads a file from the copy', () => {
    const copy = createCopy();

    expect(copy.readFile('src/a.ts')?.toString()).toBe('export const a = 1;\n');
  });

  it('returns null for a missing file', () => {
    const copy = createCopy();

    expect(copy.readFile('src/missing.ts')).toBeNull();
  });

  it('removes the copy on dispose', () => {
    const copy = createCopy();
    const dir = copy.dir;
    expect(existsSync(dir)).toBe(true);

    copy.dispose();

    expect(existsSync(dir)).toBe(false);
  });

  it('removes a lockfile a pending tree change would restore', () => {
    writeWorkspaceFile('frontend/bun.lock', 'lock\n');

    const copy = createCopy([
      { path: 'frontend/bun.lock', type: 'UPDATE', content: Buffer.from('newer\n') },
      { path: 'frontend/package-lock.json', type: 'CREATE', content: Buffer.from('{}\n') },
    ]);

    expect(copyHas(copy, 'bun.lock')).toBe(false);
    expect(copyHas(copy, 'package-lock.json')).toBe(false);
  });

  // Windows refuses symlink creation without developer mode
  const canSymlink = (() => {
    const probeRoot = mkdtempSync(join(tmpdir(), 'nx-fhir-verify-probe-'));
    try {
      writeFileSync(join(probeRoot, 'target'), '');
      symlinkSync(join(probeRoot, 'target'), join(probeRoot, 'link'), 'file');
      return true;
    } catch {
      return false;
    } finally {
      rmSync(probeRoot, { recursive: true, force: true, maxRetries: 5 });
    }
  })();

  it.skipIf(!canSymlink)('writes through a copied symlink into the copy, not the real project', () => {
    writeWorkspaceFile('frontend/shared.ts', 'real\n');
    symlinkSync(
      join(workspaceRoot, 'frontend', 'shared.ts'),
      join(workspaceRoot, 'frontend', 'src', 'link.ts'),
      'file'
    );

    const copy = createCopy([
      { path: 'frontend/src/link.ts', type: 'UPDATE', content: Buffer.from('changed\n') },
    ]);

    expect(readFileSync(join(workspaceRoot, 'frontend', 'shared.ts'), 'utf-8')).toBe('real\n');
    expect(copy.readFile('src/link.ts')?.toString()).toBe('changed\n');
    expect(lstatSync(join(copy.dir, 'src', 'link.ts')).isSymbolicLink()).toBe(false);
  });

  it('removes the directory when construction fails', () => {
    const tree = {
      root: workspaceRoot,
      listChanges: () => {
        throw new Error('listChanges failed');
      },
    } as unknown as Tree;
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('nx-fhir-verify-'));

    expect(() => createVerificationCopy({ tree, projectRoot, packageJson })).toThrow(
      'listChanges failed'
    );

    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('nx-fhir-verify-'));
    expect(after).toEqual(before);
  });

  it('maps tree paths onto the copy with the platform separator', () => {
    const copy = createCopy([
      { path: 'frontend/src/deep/a.ts', type: 'CREATE', content: Buffer.from('deep\n') },
    ]);

    expect(readFileSync(join(copy.dir, 'src', 'deep', 'a.ts'), 'utf-8')).toBe('deep\n');
  });
});
