import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FsTree } from 'nx/src/generators/tree';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discardTreeChanges } from './discard-tree-changes';

describe('discardTreeChanges', () => {
  let root: string;
  let tree: FsTree;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nx-fhir-discard-'));
    mkdirSync(join(root, 'app', 'src', 'nested'), { recursive: true });
    writeFileSync(join(root, 'app', 'package.json'), '{"name":"app"}\n');
    writeFileSync(join(root, 'app', 'src', 'main.ts'), 'main\n');
    writeFileSync(join(root, 'app', 'src', 'nested', 'deep.ts'), 'deep\n');
    tree = new FsTree(root, false);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('restores an updated file', () => {
    tree.write('app/package.json', '{"name":"changed"}\n');

    discardTreeChanges(tree);

    expect(tree.listChanges()).toEqual([]);
    expect(tree.read('app/package.json', 'utf-8')).toBe('{"name":"app"}\n');
  });

  it('removes a created file and its new folder without listing a delete', () => {
    tree.write('app/src/new/created.ts', 'created\n');

    discardTreeChanges(tree);

    expect(tree.listChanges()).toEqual([]);
    expect(tree.exists('app/src/new/created.ts')).toBe(false);
  });

  it('restores a deleted file and the parent folder it emptied', () => {
    tree.delete('app/src/nested/deep.ts');
    expect(tree.listChanges().map((change) => change.path)).toContain(
      'app/src/nested',
    );

    discardTreeChanges(tree);

    expect(tree.listChanges()).toEqual([]);
    expect(tree.read('app/src/nested/deep.ts', 'utf-8')).toBe('deep\n');
  });

  it('restores a directory deleted as a whole', () => {
    tree.delete('app/src');

    discardTreeChanges(tree);

    expect(tree.listChanges()).toEqual([]);
    expect(tree.read('app/src/main.ts', 'utf-8')).toBe('main\n');
    expect(tree.read('app/src/nested/deep.ts', 'utf-8')).toBe('deep\n');
  });

  it('leaves a tree with no changes alone', () => {
    discardTreeChanges(tree);

    expect(tree.listChanges()).toEqual([]);
  });
});
