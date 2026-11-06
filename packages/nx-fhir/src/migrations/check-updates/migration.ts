import { Tree } from '@nx/devkit';
import { runUpdate } from '../../generators/update/update';

/**
 * Migration that runs automatically during `nx migrate` to keep versions in
 * sync and prompt users if their server or frontend projects can be updated.
 * The whole workflow lives in the update generator; fromNxMigrate tells the
 * downstream generators to ignore the uncommitted files that nx migrate
 * itself changes (package.json, lock files, migrations.json).
 *
 * The server update outcome and the legacy Dockerfile warnings are returned
 * as next steps. nx migrate prints a returned string array after the list of
 * changed files and never runs a returned callback.
 */
export default async function update(tree: Tree): Promise<string[]> {
  const outcome = await runUpdate(tree, { fromNxMigrate: true });
  return (outcome ?? []).map(({ text }) => text.replace(/^\n+/, ''));
}
