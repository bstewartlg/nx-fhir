import { Tree } from '@nx/devkit';
import { UpdateServerGeneratorSchema } from '../../../generators/update-server/schema';
import { runHapiMigration } from '../../../shared/migration/hapi-migration';

export default async function update(
  tree: Tree,
  options: UpdateServerGeneratorSchema = {}
) {
  await runHapiMigration(tree, {
    fromVersion: '8.10.0-1',
    toVersion: '8.10.0-2',
    project: options.project,
  });
}
