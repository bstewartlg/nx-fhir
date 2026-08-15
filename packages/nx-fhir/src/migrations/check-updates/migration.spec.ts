import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';

const updateGenerator = vi.hoisted(() => vi.fn());

vi.mock('../../generators/update/update', () => ({ updateGenerator }));

import update from './migration';

// The migration is a thin delegate; the workflow itself is covered by the
// update generator spec.
describe('check-updates migration', () => {
  let tree: Tree;

  beforeEach(() => {
    vi.resetAllMocks();
    tree = createTreeWithEmptyWorkspace();
  });

  it('runs the update generator with the fromNxMigrate flag', async () => {
    await update(tree);

    expect(updateGenerator).toHaveBeenCalledTimes(1);
    expect(updateGenerator).toHaveBeenCalledWith(tree, { fromNxMigrate: true });
  });

  it('propagates a failure from the update generator', async () => {
    updateGenerator.mockRejectedValue(new Error('boom'));

    await expect(update(tree)).rejects.toThrow('boom');
  });
});
