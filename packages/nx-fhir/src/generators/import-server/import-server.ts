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
import { isInteractive } from '../../shared/utils/interactive';
import {
  detectExistingServer,
  DetectedServer,
} from '../../shared/utils/server-detection';
import {
  fetchStarterImageVersions,
  matchImageVersion,
} from '../../shared/utils/hapi-release-discovery';
import {
  isHapiVersionSupported,
  PLUGIN_VERSION,
  SUPPORTED_HAPI_VERSIONS,
} from '../../shared/constants/versions';

const DEFAULT_PACKAGE_BASE = 'org.custom.server';

const RELEASE_NOT_RECORDED_HELP =
  'hapiReleaseVersion was not recorded. Pass --release, or set hapiReleaseVersion in project.json, before running update-server.';

function untestedReleaseWarning(release: string): string {
  return `Release ${release} is outside the tested migration set. update-server will first merge it to the nearest tested release on a best-effort basis.`;
}

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
    options.directory && options.directory.trim() !== ''
      ? options.directory
      : '.';

  const detected = detectExistingServer(tree, directory);
  if (!detected) {
    throw new Error(
      `No existing HAPI FHIR server found at "${directory}". ` +
        `Expected a pom.xml referencing HAPI FHIR and a src/main/resources/application.yaml.`,
    );
  }

  const release = await resolveRelease(options.release, detected);
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
    // Left out entirely when unknown so a merge with an existing project.json
    // keeps any release that was recorded before.
    ...(release !== undefined ? { hapiReleaseVersion: release } : {}),
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
    `Registered existing HAPI FHIR server "${projectName}" at "${root}" (HAPI ${release ?? 'not recorded'}, FHIR ${fhirVersion}).`,
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

  // Safe to format: this generator only writes plugin authored JSON
  // (project.json, nx.json, package.json). It never touches the imported
  // server sources, which have to keep the formatting migrations merge against.
  await formatFiles(tree);
}

async function resolveRelease(
  provided: string | undefined,
  detected: DetectedServer,
): Promise<string | undefined> {
  if (provided) {
    if (isHapiVersionSupported(provided)) {
      return provided;
    }
    const imageVersions = await fetchStarterImageVersions();
    if (imageVersions?.includes(provided)) {
      logger.warn(untestedReleaseWarning(provided));
      return provided;
    }
    throw new Error(
      `Unsupported HAPI version: ${provided}. Tested releases: ${SUPPORTED_HAPI_VERSIONS.join(', ')}. ` +
        'Other releases are accepted only when they exist as an image tag on the hapi-fhir-jpaserver-starter GitHub repository.',
    );
  }

  const candidates = detected.hapiReleaseCandidates;

  // When the pom matches no tested release, the published image catalog on
  // GitHub can still identify it exactly. Discovery is skipped whenever the
  // API is unreachable.
  let discovered: string | undefined;
  // An unreadable revision leaves the image unknown; matching on the base
  // alone would guess.
  if (
    candidates.length === 0 &&
    detected.pomImage &&
    !detected.pomImage.revisionUnknown
  ) {
    const imageVersions = await fetchStarterImageVersions();
    if (imageVersions) {
      discovered = matchImageVersion(
        imageVersions,
        detected.pomImage.base,
        detected.pomImage.revision,
      );
    }
  }

  if (isInteractive()) {
    const release = await select<string | null>({
      message:
        'Which HAPI FHIR JPA Starter release does this server correspond to?',
      choices: [
        ...(discovered
          ? [
              {
                name: `${discovered} (detected from pom.xml, outside the tested set)`,
                value: discovered as string | null,
              },
            ]
          : []),
        ...[...SUPPORTED_HAPI_VERSIONS].reverse().map((v) => ({
          name: v,
          value: v as string | null,
        })),
        { name: 'None of these (leave unrecorded)', value: null },
      ],
      default:
        discovered ??
        (candidates.length > 0 ? candidates[candidates.length - 1] : null),
    });
    if (release === null) {
      logger.warn(RELEASE_NOT_RECORDED_HELP);
      return undefined;
    }
    if (release === discovered) {
      logger.warn(untestedReleaseWarning(release));
      return release;
    }
    if (!isHapiVersionSupported(release)) {
      throw new Error(`Unsupported HAPI version: ${release}`);
    }
    return release;
  }

  if (candidates.length === 1) {
    logger.info(
      `Using HAPI FHIR JPA Starter release ${candidates[0]}, the only supported release matching pom.xml.`,
    );
    return candidates[0];
  }

  if (discovered) {
    logger.warn(
      `Recording HAPI FHIR JPA Starter release ${discovered}, identified from pom.xml and verified against the published GitHub releases. ` +
        untestedReleaseWarning(discovered),
    );
    return discovered;
  }

  // Recording a guess would give a later update-server run the wrong
  // three-way-merge base, so the release stays unset until the user names it.
  logger.warn(
    (candidates.length === 0
      ? 'The pom.xml does not correspond to a supported HAPI FHIR JPA Starter release. '
      : `The pom.xml matches several supported HAPI FHIR JPA Starter releases (${candidates.join(', ')}). `) +
      RELEASE_NOT_RECORDED_HELP,
  );
  return undefined;
}

async function resolveFhirVersion(
  provided: FhirVersion | undefined,
): Promise<FhirVersion> {
  if (provided) {
    return provided;
  }
  if (!isInteractive()) {
    return announceFallback(
      FhirVersion.R4,
      `Using FHIR version ${FhirVersion.R4}`,
    );
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

async function resolvePackageBase(
  provided: string | undefined,
): Promise<string> {
  if (provided) {
    return provided;
  }
  if (!isInteractive()) {
    return announceFallback(
      DEFAULT_PACKAGE_BASE,
      `Using Java package base ${DEFAULT_PACKAGE_BASE}`,
    );
  }
  return await input({
    message: 'Enter the Java package path for your custom code',
    default: DEFAULT_PACKAGE_BASE,
  });
}

/**
 * Records the value used in place of an answer the user could not be asked for.
 * The value is reported because an unattended run silently accepting a guess is
 * hard to diagnose later.
 */
function announceFallback<T>(value: T, message: string): T {
  logger.info(`${message} (no interactive terminal available to confirm).`);
  return value;
}

export default importServerGenerator;
