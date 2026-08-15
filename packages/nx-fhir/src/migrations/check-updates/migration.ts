import { GeneratorCallback, Tree } from '@nx/devkit';
import { updateGenerator } from '../../generators/update/update';

/**
 * Migration that runs automatically during `nx migrate` to keep versions in
 * sync and prompt users if their server or frontend projects can be updated.
 * The whole workflow lives in the update generator; fromNxMigrate tells the
 * downstream generators to ignore the uncommitted files that nx migrate
 * itself changes (package.json, lock files, migrations.json).
 */
export default async function update(
  tree: Tree,
): Promise<GeneratorCallback | undefined> {
  return updateGenerator(tree, { fromNxMigrate: true });
}
