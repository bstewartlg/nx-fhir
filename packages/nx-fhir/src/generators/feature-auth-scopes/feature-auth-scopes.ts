import { Tree } from '@nx/devkit';
import { FeatureAuthScopesGeneratorSchema } from './schema';
import { runFeature } from '../feature/run-feature';

export async function featureAuthScopesGenerator(
  tree: Tree,
  options: FeatureAuthScopesGeneratorSchema,
) {
  await runFeature(tree, {
    feature: 'auth-scopes',
    project: options.project,
    options: {},
  });
}

export default featureAuthScopesGenerator;
