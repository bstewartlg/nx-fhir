import { Tree } from '@nx/devkit';
import { FeatureAuthUdapGeneratorSchema } from './schema';
import { runFeature } from '../feature/run-feature';

export async function featureAuthUdapGenerator(
  tree: Tree,
  options: FeatureAuthUdapGeneratorSchema,
) {
  const { project, ...featureOptions } = options;
  // An option the caller leaves undefined must not reach collectOptions as a
  // key, or it overrides the default collectOptions would apply.
  const provided = Object.fromEntries(
    Object.entries(featureOptions).filter(([, value]) => value !== undefined),
  );
  await runFeature(tree, {
    feature: 'auth-udap',
    project,
    options: provided,
  });
}

export default featureAuthUdapGenerator;
