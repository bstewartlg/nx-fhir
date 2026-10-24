import { Tree } from '@nx/devkit';
import { FeatureOtelGeneratorSchema } from './schema';
import { runFeature } from '../feature/run-feature';

export async function featureOtelGenerator(
  tree: Tree,
  options: FeatureOtelGeneratorSchema,
) {
  const { project, ...featureOptions } = options;
  // An option the caller leaves undefined must not reach collectOptions as a
  // key, or it overrides the default collectOptions would apply.
  const provided = Object.fromEntries(
    Object.entries(featureOptions).filter(([, value]) => value !== undefined),
  );
  await runFeature(tree, { feature: 'otel', project, options: provided });
}

export default featureOtelGenerator;
