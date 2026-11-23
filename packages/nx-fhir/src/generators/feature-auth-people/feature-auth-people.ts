import { Tree } from '@nx/devkit';
import { FeatureAuthPeopleGeneratorSchema } from './schema';
import { AUTH_PEOPLE_FEATURE } from './auth-people';
import { runFeature } from '../feature/run-feature';

export async function featureAuthPeopleGenerator(
  tree: Tree,
  options: FeatureAuthPeopleGeneratorSchema,
) {
  await runFeature(tree, {
    feature: AUTH_PEOPLE_FEATURE,
    project: options.project,
    options: {},
  });
}

export default featureAuthPeopleGenerator;
