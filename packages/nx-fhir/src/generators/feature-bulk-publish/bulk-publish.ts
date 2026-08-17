import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import { confirm, input } from '@inquirer/prompts';
import * as path from 'path';

import { FeatureDefinition } from '../feature/types';
import { ensureGitignoreEntries, updateServerYaml } from '../../shared/utils';
import {
  detectApplicationClass,
  ensureServerWiring,
  listTemplateOutputs,
} from '../../shared/utils/server-wiring';
import { isInteractive } from '../../shared/utils/interactive';

const RESOURCE_TYPE_PATTERN = /^[A-Z][A-Za-z]*$/;

// The type the publisher writes into the manifest outcome property, so a configured entry for it
// would collide with the file the publisher owns.
const OUTCOME_TYPE = 'OperationOutcome';

// Search parameters the exporter owns, either because it sets them itself or because they
// would change the shape of the exported page.
const RESERVED_FILTER_PARAMS = new Set([
  '_lastUpdated',
  '_sort',
  '_count',
  '_offset',
  '_include',
  '_revinclude',
  '_summary',
  '_elements',
]);

interface BulkPublishOptions {
  resourceTypes: string[];
  intervalMs: number;
  transactionLagMs: number;
  storagePath: string;
  resetOnStartup: boolean;
  publicBaseUrl?: string;
}

function parseResourceTypes(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.map(String)
    : String(value)
        .split(',')
        .map((type) => type.trim())
        .filter((type) => type.length > 0);
  // Exact duplicates collapse; two entries that differ only by their filter collide on the
  // published file name and are rejected below.
  const entries: string[] = [];
  const seenTypes = new Set<string>();
  for (const entry of new Set(list)) {
    const separator = entry.indexOf('?');
    const type = separator < 0 ? entry : entry.slice(0, separator);
    const filter = separator < 0 ? '' : entry.slice(separator + 1);
    if (!RESOURCE_TYPE_PATTERN.test(type)) {
      throw new Error(
        `Invalid resource type '${type}'. Resource types must match [A-Z][A-Za-z]*.`,
      );
    }
    if (type === OUTCOME_TYPE) {
      throw new Error(
        `Resource type '${OUTCOME_TYPE}' is reserved for the manifest outcome property.`,
      );
    }
    if (filter && /\s/.test(filter)) {
      throw new Error(
        `Invalid filter for resource type '${type}'. Provide search parameters after '?', e.g. Patient?active=true.`,
      );
    }
    for (const parameter of filter ? filter.split('&') : []) {
      const equals = parameter.indexOf('=');
      const name = equals < 0 ? parameter : parameter.slice(0, equals);
      if (RESERVED_FILTER_PARAMS.has(name)) {
        throw new Error(
          `Filter for resource type '${type}' must not set '${name}'. The publisher controls it.`,
        );
      }
      // A blank value is dropped during match URL translation, which would silently export the
      // whole type while the configuration reads as filtered.
      if (equals < 0 || parameter.slice(equals + 1) === '') {
        throw new Error(
          `Filter for resource type '${type}' must give '${name}' a value.`,
        );
      }
    }
    if (seenTypes.has(type)) {
      throw new Error(
        `Resource type '${type}' is configured more than once. Combine filters into one entry.`,
      );
    }
    seenTypes.add(type);
    entries.push(filter ? entry : type);
  }
  return entries;
}

/**
 * The feature picker forwards command line values uncoerced, so a boolean arrives as a string.
 * Only the two spellings of a boolean are accepted; anything else is a typo the user must fix.
 */
function parseBooleanOption(name: string, value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  if (normalized === 'true' || normalized === 'false') {
    return normalized === 'true';
  }
  throw new Error(`Invalid ${name} '${value}'. Provide true or false.`);
}

export const bulkPublishFeature: FeatureDefinition = {
  name: 'bulk-publish',
  description:
    'Publish server data as bulk ndjson snapshots behind a $bulk-publish manifest endpoint',
  featureVersion: 1,
  // Verified floor: compile, unit tests, and BulkPublishIT pass on rendered
  // starter servers at 7.4.0, 7.6.0, 8.0.0, and 8.8.0-1 under JDK 17.
  minHapiVersion: '7.4.0',

  async collectOptions(tree, project, provided) {
    const allTypes =
      provided.allTypes !== undefined
        ? parseBooleanOption('allTypes', provided.allTypes)
        : false;

    let resourceTypes: string[];
    if (provided.resourceTypes !== undefined) {
      resourceTypes = parseResourceTypes(provided.resourceTypes);
    } else if (!allTypes && isInteractive()) {
      resourceTypes = parseResourceTypes(
        await input({
          message:
            'Resource types to publish (comma-separated; each entry may carry a search filter, e.g. Organization,Patient?active=true; leave empty to publish every supported type):',
        }),
      );
    } else {
      resourceTypes = [];
    }

    if (allTypes && resourceTypes.length > 0) {
      throw new Error(
        'allTypes cannot be combined with a resourceTypes list. Provide one or the other.',
      );
    }
    // An empty list is the server's "publish every supported type" mode. The published files are
    // readable without authentication, so that mode requires explicit consent.
    if (resourceTypes.length === 0 && !allTypes) {
      if (!isInteractive()) {
        throw new Error(
          'No resource types provided. Provide resourceTypes, or set allTypes to publish every type the server supports.',
        );
      }
      const publishEverything = await confirm({
        message:
          'Publish every resource type the server supports to unauthenticated readers?',
        default: false,
      });
      if (!publishEverything) {
        throw new Error(
          'Bulk publish needs a resource type list. Rerun and provide resource types, or set allTypes to publish every supported type.',
        );
      }
    }

    const intervalMs =
      provided.intervalMs !== undefined
        ? Number(provided.intervalMs)
        : isInteractive()
          ? Number(
              await input({
                message: 'Publish interval in milliseconds:',
                default: '60000',
              }),
            )
          : 60000;

    const transactionLagMs =
      provided.transactionLagMs !== undefined
        ? Number(provided.transactionLagMs)
        : isInteractive()
          ? Number(
              await input({
                message:
                  'Transaction time lag in milliseconds (how far behind the export start each snapshot claims its transactionTime):',
                default: '60000',
              }),
            )
          : 60000;

    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(
        `Invalid intervalMs '${intervalMs}'. Provide a positive integer number of milliseconds.`,
      );
    }
    if (!Number.isInteger(transactionLagMs) || transactionLagMs < 0) {
      throw new Error(
        `Invalid transactionLagMs '${transactionLagMs}'. Provide a non-negative integer number of milliseconds.`,
      );
    }

    const storagePath =
      provided.storagePath !== undefined
        ? String(provided.storagePath)
        : isInteractive()
          ? await input({
              message:
                'Snapshot storage path (relative to the server working directory):',
              default: './publish-data',
            })
          : './publish-data';

    const resetOnStartup =
      provided.resetOnStartup !== undefined
        ? parseBooleanOption('resetOnStartup', provided.resetOnStartup)
        : isInteractive()
          ? await confirm({
              message: 'Delete published snapshots on server startup?',
              default: false,
            })
          : false;

    const options: BulkPublishOptions = {
      resourceTypes,
      intervalMs,
      transactionLagMs,
      storagePath,
      resetOnStartup,
    };
    const publicBaseUrl =
      provided.publicBaseUrl !== undefined
        ? String(provided.publicBaseUrl)
        : '';
    if (publicBaseUrl) {
      options.publicBaseUrl = publicBaseUrl;
    }
    return options as unknown as Record<string, unknown>;
  },

  async apply(tree: Tree, project, rawOptions) {
    const options = rawOptions as unknown as BulkPublishOptions;
    const packagePath = project.packageBase.replace(/\./g, '/');
    const applicationClassFqn = detectApplicationClass(tree, project.root);
    const substitutions = {
      packageBase: project.packageBase,
      applicationClassFqn,
      applicationClassName: applicationClassFqn.split('.').pop() as string,
    };

    ensureServerWiring(tree, {
      root: project.root,
      packageBase: project.packageBase,
    });

    const mainTarget = path.join(project.root, 'src', 'main', 'java', packagePath);
    const testTarget = path.join(project.root, 'src', 'test', 'java', packagePath);
    const collisions = [
      ...listTemplateOutputs(
        path.join(__dirname, 'files', 'main'),
        substitutions,
      ).map((relative) => path.join(mainTarget, relative)),
      ...listTemplateOutputs(
        path.join(__dirname, 'files', 'test'),
        substitutions,
      ).map((relative) => path.join(testTarget, relative)),
    ].filter((file) => tree.exists(file));
    if (collisions.length > 0) {
      throw new Error(
        `feature bulk-publish would overwrite files that already exist:\n${collisions.join(
          '\n',
        )}\nMove or remove them before installing the feature.`,
      );
    }

    // The published snapshots hold exported resource data, which must not reach a commit.
    if (!path.isAbsolute(options.storagePath)) {
      const entry = options.storagePath.replace(/^\.\//, '').replace(/\/$/, '');
      if (entry && !entry.startsWith('..')) {
        ensureGitignoreEntries(tree, path.join(project.root, '.gitignore'), [
          `${entry}/`,
        ]);
      }
    }

    // The pre-check above reports every collision at once; the strategy is the backstop for a
    // path it fails to predict.
    generateFiles(
      tree,
      path.join(__dirname, 'files', 'main'),
      mainTarget,
      substitutions,
      { overwriteStrategy: OverwriteStrategy.ThrowIfExisting },
    );

    generateFiles(
      tree,
      path.join(__dirname, 'files', 'test'),
      testTarget,
      substitutions,
      { overwriteStrategy: OverwriteStrategy.ThrowIfExisting },
    );

    // Written key by key so any other publish setting already in the file survives.
    updateServerYaml(project.root, tree, 'publish.enabled', true);
    updateServerYaml(project.root, tree, 'publish.interval-ms', options.intervalMs);
    updateServerYaml(
      project.root,
      tree,
      'publish.transaction-lag-ms',
      options.transactionLagMs,
    );
    updateServerYaml(
      project.root,
      tree,
      'publish.storage-path',
      options.storagePath,
    );
    updateServerYaml(
      project.root,
      tree,
      'publish.reset-on-startup',
      options.resetOnStartup,
    );
    updateServerYaml(
      project.root,
      tree,
      'publish.resource-types',
      options.resourceTypes,
    );
    if (options.publicBaseUrl) {
      updateServerYaml(
        project.root,
        tree,
        'publish.public-base-url',
        options.publicBaseUrl,
      );
    }
  },
};
