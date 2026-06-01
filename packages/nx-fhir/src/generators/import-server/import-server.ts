import {
  addProjectConfiguration,
  formatFiles,
  joinPathFragments,
  logger,
  readJson,
  Tree,
  updateJson,
} from '@nx/devkit';
import * as path from 'path';
import { input, select } from '@inquirer/prompts';
import { ImportServerGeneratorSchema } from './schema';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';
import { registerNxPlugin } from '../../shared/utils';
import { detectExistingServer } from '../../shared/utils/server-detection';
import {
  DEFAULT_HAPI_VERSION,
  isHapiVersionSupported,
  PLUGIN_VERSION,
  SUPPORTED_HAPI_VERSIONS,
} from '../../shared/constants/versions';

/**
 * Registers an already-present HAPI FHIR JPA Starter server as an Nx project.
 *
 * This is non-destructive: it only writes project.json and registers the nx-fhir plugin.
 * It never downloads a release or modifies the server's pom.xml, sources, or application.yaml.
 */
export async function importServerGenerator(
  tree: Tree,
  options: ImportServerGeneratorSchema,
) {
  const directory =
    options.directory && options.directory.trim() !== '' ? options.directory : '.';

  const detected = detectExistingServer(tree, directory);
  if (!detected) {
    throw new Error(
      `No existing HAPI FHIR server found at "${directory}". ` +
        `Expected a pom.xml referencing HAPI FHIR and a src/main/resources/application.yaml.`,
    );
  }

  const release = await resolveRelease(options.release, detected.hapiReleaseVersion);
  const fhirVersion = await resolveFhirVersion(
    options.fhirVersion ?? detected.fhirVersion,
  );
  const packageBase = await resolvePackageBase(
    options.packageBase ?? detected.packageBase,
  );

  const root = detected.root;
  const sourceRoot = root === '.' ? 'src' : joinPathFragments(root, 'src');

  const projectJsonPath = joinPathFragments(root, 'project.json');
  const existing = tree.exists(projectJsonPath)
    ? readJson(tree, projectJsonPath)
    : null;

  // Prefer an explicit name, then the name already recorded in project.json, and only
  // fall back to the directory name when neither is available.
  const projectName =
    options.name ??
    existing?.name ??
    path.basename(root === '.' ? tree.root : root);

  const projectConfiguration: ServerProjectConfiguration = {
    root,
    projectType: 'application',
    sourceRoot,
    tags: ['nx-fhir-server', 'fhir', 'server'],
    packageBase,
    fhirVersion,
    hapiReleaseVersion: release,
    pluginVersion: PLUGIN_VERSION,
  };

  if (existing) {
    logger.warn(
      `A project.json already exists at ${projectJsonPath}; merging nx-fhir server configuration into it.`,
    );
    const tags = [
      ...new Set([
        ...(existing.tags ?? []),
        ...(projectConfiguration.tags ?? []),
      ]),
    ];
    tree.write(
      projectJsonPath,
      JSON.stringify(
        { ...existing, ...projectConfiguration, name: projectName, tags },
        null,
        2,
      ),
    );
  } else {
    addProjectConfiguration(tree, projectName, projectConfiguration);
  }

  logger.info(
    `Registered existing HAPI FHIR server "${projectName}" at "${root}" (HAPI ${release}, FHIR ${fhirVersion}).`,
  );

  await registerNxPlugin(tree);

  // A server imported at the workspace root shares the workspace package.json.
  // This prevents looping when running something like "nx run server:serve"
  if (root === '.' && tree.exists('package.json')) {
    updateJson(tree, 'package.json', (json) => {
      json.nx = { ...(json.nx ?? {}), includedScripts: [] };
      return json;
    });
  }

  await formatFiles(tree);
}

async function resolveRelease(
  provided: string | undefined,
  detected: string | undefined,
): Promise<string> {
  const release =
    provided ??
    (await select({
      message: 'Which HAPI FHIR JPA Starter release does this server correspond to?',
      choices: SUPPORTED_HAPI_VERSIONS.map((v) => ({ name: v, value: v })),
      default: detected ?? DEFAULT_HAPI_VERSION,
    }));

  if (!isHapiVersionSupported(release)) {
    throw new Error(`Unsupported HAPI version: ${release}`);
  }
  return release;
}

async function resolveFhirVersion(
  provided: FhirVersion | undefined,
): Promise<FhirVersion> {
  if (provided) {
    return provided;
  }
  return (await select({
    message: 'Select the FHIR version for this server',
    choices: [
      { name: 'STU3', value: 'STU3' },
      { name: 'R4', value: 'R4' },
      { name: 'R4B', value: 'R4B' },
      { name: 'R5', value: 'R5' },
    ],
    default: 'R4',
  })) as FhirVersion;
}

async function resolvePackageBase(provided: string | undefined): Promise<string> {
  if (provided) {
    return provided;
  }
  return await input({
    message: 'Enter the Java package path for your custom code',
    default: 'org.custom.server',
  });
}

export default importServerGenerator;
