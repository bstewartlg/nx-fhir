import { Tree } from '@nx/devkit';
import { FeatureAuthSmartGeneratorSchema } from './schema';
import { runFeature } from '../feature/run-feature';

export async function featureAuthSmartGenerator(
  tree: Tree,
  options: FeatureAuthSmartGeneratorSchema,
) {
  await runFeature(tree, {
    feature: 'auth-smart',
    project: options.project,
    options: {},
  });
}

export default featureAuthSmartGenerator;
