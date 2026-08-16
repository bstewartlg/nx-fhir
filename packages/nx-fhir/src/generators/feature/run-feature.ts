import {
  joinPathFragments,
  logger,
  readProjectConfiguration,
  Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { InstalledFeature, ServerProjectConfiguration } from '../../shared/models';
import { getServerProjects, promptForServerProject } from '../../shared/utils';
import { compareHapiVersions } from '../../shared/migration/hapi-migration-resolver';
import { detectPomImageIdentity } from '../../shared/utils/server-detection';
import { FEATURES } from './registry';
import { FeatureDefinition } from './types';

export interface RunFeatureOptions {
  feature: string;
  project?: string;
  options?: Record<string, unknown>;
}

function supportedRange(feature: FeatureDefinition): string {
  return feature.maxHapiVersion
    ? `${feature.minHapiVersion} through ${feature.maxHapiVersion}`
    : `${feature.minHapiVersion} and later`;
}

/**
 * Refuses an install whose generated Java cannot compile against the HAPI FHIR
 * libraries the server builds with. The hapi-fhir parent version in pom.xml is
 * the source, so the check works on a server whose project.json records no
 * release. A pom that names no HAPI parent leaves the check impossible, and the
 * install proceeds with a warning.
 */
function assertHapiCompatibility(
  tree: Tree,
  feature: FeatureDefinition,
  project: ServerProjectConfiguration,
  projectName: string,
): void {
  const pomPath = joinPathFragments(project.root, 'pom.xml');
  const detected = detectPomImageIdentity(tree.read(pomPath, 'utf-8') ?? '')?.base;
  if (!detected) {
    logger.warn(
      `Cannot check HAPI FHIR compatibility for feature '${feature.name}': ${pomPath} names no HAPI FHIR parent version. ` +
        `The feature supports HAPI FHIR ${supportedRange(feature)}. Proceeding with the install.`,
    );
    return;
  }

  const belowFloor = compareHapiVersions(detected, feature.minHapiVersion) < 0;
  const aboveCeiling =
    feature.maxHapiVersion !== undefined &&
    compareHapiVersions(detected, feature.maxHapiVersion) > 0;
  if (belowFloor || aboveCeiling) {
    throw new Error(
      `Feature '${feature.name}' supports HAPI FHIR ${supportedRange(feature)}, but project '${projectName}' builds against HAPI FHIR ${detected} according to ${pomPath}. ` +
        `The generated Java does not compile against that release. Run the update-server generator to move '${projectName}' into the supported range, or add the feature to a server that is already in it.`,
    );
  }
}

export async function runFeature(
  tree: Tree,
  opts: RunFeatureOptions,
  registry: FeatureDefinition[] = FEATURES
): Promise<void> {
  const feature = registry.find((f) => f.name === opts.feature);
  if (!feature) {
    const available = registry.map((f) => f.name).join(', ');
    throw new Error(`Unknown feature '${opts.feature}'. Available features: ${available}`);
  }

  let projectName = opts.project;
  if (projectName) {
    const serverProjects = await getServerProjects(tree);
    if (!serverProjects.includes(projectName)) {
      throw new Error(`Project '${projectName}' is not a server project.`);
    }
  } else {
    projectName = await promptForServerProject(
      tree,
      `Select a server project to add the ${feature.name} feature to:`
    );
  }
  const project = readProjectConfiguration(tree, projectName) as ServerProjectConfiguration;

  if (project.features?.[feature.name]) {
    throw new Error(`Feature '${feature.name}' is already installed on project '${projectName}'.`);
  }

  assertHapiCompatibility(tree, feature, project, projectName);

  const options = await feature.collectOptions(tree, project, opts.options ?? {});
  await feature.apply(tree, project, options);

  // Re-read so any project.json change apply makes survives: updateProjectConfiguration
  // writes the whole object, and the object read above predates apply.
  const installed: InstalledFeature = { version: feature.featureVersion, options };
  const updated = readProjectConfiguration(tree, projectName) as ServerProjectConfiguration;
  updated.features = { ...(updated.features ?? {}), [feature.name]: installed };
  updateProjectConfiguration(tree, projectName, updated);
  logger.info(`Added feature '${feature.name}' to project '${projectName}'.`);
}
