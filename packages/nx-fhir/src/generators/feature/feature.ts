import { Tree } from '@nx/devkit';
import { select } from '@inquirer/prompts';
import { FeatureGeneratorSchema } from './schema';
import { FEATURES } from './registry';
import { isInteractive } from '../../shared/utils/interactive';
import { runFeature } from './run-feature';

export async function featureGenerator(tree: Tree, options: FeatureGeneratorSchema) {
  const { feature, project, ...rest } = options;
  let featureName = feature;
  if (!featureName) {
    if (!isInteractive()) {
      const available = FEATURES.map((f) => f.name).join(', ');
      throw new Error(`Missing required option --feature. Available features: ${available}`);
    }
    featureName = await select({
      message: 'Select a feature to add:',
      choices: FEATURES.map((f) => ({ name: f.name, value: f.name, description: f.description })),
    });
  }
  // Every option the picker does not own belongs to the feature. An option the caller
  // leaves undefined must not reach collectOptions as a key, or it overrides the default
  // collectOptions would apply.
  const provided = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  );
  await runFeature(tree, { feature: featureName, project, options: provided });
}

export default featureGenerator;
