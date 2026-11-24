import { Tree } from '@nx/devkit';
import { FeatureAuthLoginGeneratorSchema } from './schema';
import { AUTH_LOGIN_FEATURE } from './auth-login';
import { runFeature } from '../feature/run-feature';

export async function featureAuthLoginGenerator(
  tree: Tree,
  options: FeatureAuthLoginGeneratorSchema,
) {
  const { project, ...featureOptions } = options;
  // An option the caller leaves undefined must not reach collectOptions as a
  // key, or it overrides the default collectOptions would apply.
  const provided = Object.fromEntries(
    Object.entries(featureOptions).filter(([, value]) => value !== undefined),
  );
  await runFeature(tree, {
    feature: AUTH_LOGIN_FEATURE,
    project,
    options: provided,
  });
}

export default featureAuthLoginGenerator;
