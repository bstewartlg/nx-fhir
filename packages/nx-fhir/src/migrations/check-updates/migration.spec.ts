import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';

const runUpdate = vi.hoisted(() => vi.fn());

vi.mock('../../generators/update/update', () => ({ runUpdate }));

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

    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(runUpdate).toHaveBeenCalledWith(tree, { fromNxMigrate: true });
  });

  it('returns the outcome of a paused server update as next steps', async () => {
    runUpdate.mockResolvedValue([
      {
        level: 'warn',
        text: '\n⚠️  Migration chain paused: server is at HAPI FHIR 8.10.0-1 with unresolved conflicts.',
      },
      { level: 'warn', text: '  - server/pom.xml' },
      {
        level: 'warn',
        text: '    Resolve the conflicts, then run the update-server generator again to continue (2 step(s) remaining).',
      },
    ]);

    await expect(update(tree)).resolves.toEqual([
      '⚠️  Migration chain paused: server is at HAPI FHIR 8.10.0-1 with unresolved conflicts.',
      '  - server/pom.xml',
      '    Resolve the conflicts, then run the update-server generator again to continue (2 step(s) remaining).',
    ]);
  });

  it('returns the outcome of a finished server update as next steps', async () => {
    runUpdate.mockResolvedValue([
      { level: 'info', text: '\n✅ server updated to HAPI FHIR 8.12.0-2.' },
    ]);

    await expect(update(tree)).resolves.toEqual([
      '✅ server updated to HAPI FHIR 8.12.0-2.',
    ]);
  });

  it('returns the legacy warning as next steps', async () => {
    runUpdate.mockResolvedValue([
      { level: 'warn', text: 'The server stages in the combined Dockerfile do not get HAPI starter updates.' },
      { level: 'warn', text: '1. Download the HAPI starter for release 8.12.0-2:' },
    ]);

    await expect(update(tree)).resolves.toEqual([
      'The server stages in the combined Dockerfile do not get HAPI starter updates.',
      '1. Download the HAPI starter for release 8.12.0-2:',
    ]);
  });

  it('returns no next steps when there is no server update', async () => {
    runUpdate.mockResolvedValue(undefined);

    await expect(update(tree)).resolves.toEqual([]);
  });

  it('propagates a failure from the update generator', async () => {
    runUpdate.mockRejectedValue(new Error('boom'));

    await expect(update(tree)).rejects.toThrow('boom');
  });
});
