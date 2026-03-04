import { Tree } from '@nx/devkit';
import { UpdateServerGeneratorSchema } from '../../../generators/update-server/schema';
import { runHapiMigration } from '../../../shared/migration/hapi-migration';

export default async function update(
  tree: Tree,
  options: UpdateServerGeneratorSchema = {}
) {
  await runHapiMigration(tree, {
    fromVersion: '8.6.0-1',
    toVersion: '8.8.0-1',
    project: options.project,
  });
}
