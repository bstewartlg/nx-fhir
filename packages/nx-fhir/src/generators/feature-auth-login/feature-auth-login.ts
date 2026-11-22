import { Tree } from '@nx/devkit';
import { FeatureAuthLoginGeneratorSchema } from './schema';
import { AUTH_LOGIN_FEATURE } from './auth-login';
import { runFeature } from '../feature/run-feature';

export async function featureAuthLoginGenerator(
  tree: Tree,
  options: FeatureAuthLoginGeneratorSchema,
) {
  await runFeature(tree, {
    feature: AUTH_LOGIN_FEATURE,
    project: options.project,
    options: {},
  });
}

export default featureAuthLoginGenerator;
