import { Tree } from '@nx/devkit';
import { FeatureFrontendProxyGeneratorSchema } from './schema';
import { FRONTEND_PROXY_FEATURE } from './frontend-proxy';
import { runFeature } from '../feature/run-feature';

export async function featureFrontendProxyGenerator(
  tree: Tree,
  options: FeatureFrontendProxyGeneratorSchema,
) {
  const { project, ...featureOptions } = options;
  // An option the caller leaves undefined must not reach collectOptions as a
  // key, or it overrides the default collectOptions would apply.
  const provided = Object.fromEntries(
    Object.entries(featureOptions).filter(([, value]) => value !== undefined),
  );
  await runFeature(tree, {
    feature: FRONTEND_PROXY_FEATURE,
    project,
    options: provided,
  });
}

export default featureFrontendProxyGenerator;
