import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import { input } from '@inquirer/prompts';
import * as path from 'path';
import { Document, parseDocument } from 'yaml';

import { FeatureDefinition } from '../feature/types';
import { updateServerYaml } from '../../shared/utils';
import { isInteractive } from '../../shared/utils/interactive';
import {
  detectApplicationClass,
  ensureServerWiring,
  listTemplateOutputs,
} from '../../shared/utils/server-wiring';

interface AuthResourceOptions {
  issuer: string;
  audience: string;
}

// Spring Boot loads config/application.yaml for each test and application-test.yaml for the test profile.
const TEST_CONFIG_FILES = [
  path.join('src', 'test', 'resources', 'config', 'application.yaml'),
  path.join('src', 'test', 'resources', 'application-test.yaml'),
];

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** The text of a test configuration file with app.auth.enabled set to false. */
function withCheckOff(tree: Tree, file: string): string {
  const doc = parseDocument(tree.read(file, 'utf-8') ?? '');
  doc.setIn(['app', 'auth', 'enabled'], false);
  return doc.toString();
}

export const authResourceFeature: FeatureDefinition = {
  name: 'auth-resource',
  description: 'Require a bearer token from a configured issuer on the FHIR endpoint',
  featureVersion: 1,
  minHapiVersion: '8.8.0',

  async collectOptions(tree, project, provided) {
    const issuer = (
      provided.issuer !== undefined
        ? String(provided.issuer)
        : isInteractive()
          ? await input({
              message:
                'Token issuer URL (the iss claim). Leave empty to add issuers later in application.yaml:',
            })
          : ''
    ).trim();
    const audience = (
      provided.audience !== undefined
        ? String(provided.audience)
        : issuer && isInteractive()
          ? await input({
              message:
                'Audience that the aud claim must contain. Leave empty for no audience check:',
            })
          : ''
    ).trim();

    if (issuer && !isHttpUrl(issuer)) {
      throw new Error(
        `Invalid issuer '${issuer}'. Use an absolute http or https URL.`,
      );
    }
    if (audience && !issuer) {
      throw new Error('The audience option needs an issuer option.');
    }
    const options: AuthResourceOptions = { issuer, audience };
    return options as unknown as Record<string, unknown>;
  },

  async apply(tree: Tree, project, rawOptions) {
    const options = rawOptions as unknown as AuthResourceOptions;
    const packagePath = project.packageBase.replace(/\./g, '/');
    const applicationClassFqn = detectApplicationClass(tree, project.root);
    const substitutions = {
      packageBase: project.packageBase,
      applicationClassFqn,
      applicationClassName: applicationClassFqn.split('.').pop() as string,
      fhirVersion: project.fhirVersion,
    };

    ensureServerWiring(tree, {
      root: project.root,
      packageBase: project.packageBase,
    });

    const groups: Array<[group: string, target: string]> = [
      ['main', path.join(project.root, 'src', 'main', 'java', packagePath)],
      ['test', path.join(project.root, 'src', 'test', 'java', packagePath)],
      ['docs', project.root],
    ];
    const collisions = groups
      .flatMap(([group, target]) =>
        listTemplateOutputs(
          path.join(__dirname, 'files', group),
          substitutions,
        ).map((relative) => path.join(target, relative)),
      )
      .filter((file) => tree.exists(file));
    if (collisions.length > 0) {
      throw new Error(
        `feature auth-resource would overwrite files that already exist:\n${collisions.join(
          '\n',
        )}\nMove or remove them before installing the feature.`,
      );
    }

    // Each yaml step that can refuse runs before the first yaml write, so a refusal leaves the yaml files unchanged.
    const testConfigs = TEST_CONFIG_FILES.map((relative) => {
      const file = path.join(project.root, relative);
      return [file, withCheckOff(tree, file)];
    });

    const auth = new Document().createNode({
      enabled: Boolean(options.issuer),
      issuers: options.issuer
        ? [
            {
              issuer: options.issuer,
              ...(options.audience ? { audience: options.audience } : {}),
            },
          ]
        : [],
      'public-endpoints': [],
    });
    // The comment follows the last key at the indentation of the app.auth keys, so the removal of "# " turns the bypass on.
    auth.comment = ' bypass-header: X-Bypass-Auth';
    updateServerYaml(project.root, tree, 'app.auth', auth);

    for (const [file, content] of testConfigs) {
      tree.write(file, content);
    }

    // The pre-check above reports every collision at once. The strategy is the backstop for a
    // path it fails to predict.
    for (const [group, target] of groups) {
      generateFiles(
        tree,
        path.join(__dirname, 'files', group),
        target,
        substitutions,
        {
          overwriteStrategy: OverwriteStrategy.ThrowIfExisting,
        },
      );
    }
  },
};
