import { Tree } from '@nx/devkit';
import { FeatureBulkPublishGeneratorSchema } from './schema';
import { runFeature } from '../feature/run-feature';

export async function featureBulkPublishGenerator(
  tree: Tree,
  options: FeatureBulkPublishGeneratorSchema,
) {
  const { project, ...featureOptions } = options;
  // An option the caller leaves undefined must not reach collectOptions as a
  // key, or it overrides the default collectOptions would apply.
  const provided = Object.fromEntries(
    Object.entries(featureOptions).filter(([, value]) => value !== undefined),
  );
  await runFeature(tree, { feature: 'bulk-publish', project, options: provided });
}

export default featureBulkPublishGenerator;
