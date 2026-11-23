import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import { input, select } from '@inquirer/prompts';
import * as path from 'path';
import { Document, isMap, parseDocument, Scalar, YAMLMap } from 'yaml';

import { FeatureDefinition } from '../feature/types';
import { isInteractive } from '../../shared/utils/interactive';
import {
  detectApplicationClass,
  ensureServerWiring,
  listTemplateOutputs,
} from '../../shared/utils/server-wiring';

export const AUTH_RESOURCE_FEATURE = 'auth-resource';
export const DEFAULT_ISSUER = 'https://udap-security.fast.hl7.org';
export const LOCAL_FAST_ISSUER = 'https://localhost:5001';
export const OTHER_ISSUER = 'other';

interface AuthResourceOptions {
  issuer: string;
  audience: string;
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function parseYaml(file: string, text: string): Document {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid YAML in ${file}. ${doc.errors[0].message}`);
  }
  return doc;
}

/** Sets app.auth.<key> to the value as a block-style map. */
export function setAuthMap(
  config: Document,
  key: string,
  value: Record<string, unknown>,
): void {
  const map = config.createNode(value) as YAMLMap;
  map.flow = false;
  // The trailing comment of app.auth holds the bypass-header line of auth-resource. Before the new key, the line
  // stays with the app.auth keys, so the removal of "# " gives app.auth.bypass-header.
  const mapKey = new Scalar(key);
  const auth = config.getIn(['app', 'auth'], true);
  if (isMap(auth)) {
    mapKey.commentBefore = auth.comment;
    auth.comment = undefined;
  }
  config.setIn(['app', 'auth', mapKey], map);
}

/** Returns the path and the new text of each test configuration file with the value at keyPath set to false. The caller writes the files. */
export function testConfigsWithKeyOff(
  tree: Tree,
  projectRoot: string,
  keyPath: string[],
): Array<[file: string, content: string]> {
  // Spring Boot loads config/application.yaml for each test and application-test.yaml for the test profile.
  return [
    path.join('src', 'test', 'resources', 'config', 'application.yaml'),
    path.join('src', 'test', 'resources', 'application-test.yaml'),
  ].map((relative) => {
    const file = path.join(projectRoot, relative);
    const doc = parseYaml(file, tree.read(file, 'utf-8') ?? '');
    doc.setIn(keyPath, false);
    return [file, doc.toString()];
  });
}

async function askForIssuer(): Promise<string> {
  const choice = await select({
    message: 'Token issuer URL (the iss claim):',
    choices: [
      {
        name: `${DEFAULT_ISSUER} (public FAST security server)`,
        value: DEFAULT_ISSUER,
      },
      {
        name: `${LOCAL_FAST_ISSUER} (local FAST security server)`,
        value: LOCAL_FAST_ISSUER,
      },
      { name: 'Other', value: OTHER_ISSUER },
    ],
    default: DEFAULT_ISSUER,
  });
  return choice === OTHER_ISSUER
    ? input({ message: 'Token issuer URL:' })
    : choice;
}

export const authResourceFeature: FeatureDefinition = {
  name: AUTH_RESOURCE_FEATURE,
  description: 'Require a bearer token from a configured issuer on the FHIR endpoint',
  featureVersion: 1,
  minHapiVersion: '8.8.0',

  async collectOptions(tree, project, provided) {
    const issuer = (
      provided.issuer !== undefined
        ? String(provided.issuer)
        : isInteractive()
          ? await askForIssuer()
          : DEFAULT_ISSUER
    ).trim();
    const audience = (
      provided.audience !== undefined
        ? String(provided.audience)
        : isInteractive()
          ? await input({
              message:
                'Audience that the aud claim must contain. Leave empty for no audience check:',
            })
          : ''
    ).trim();

    if (!isHttpUrl(issuer)) {
      throw new Error(
        `Invalid issuer '${issuer}'. Use an absolute http or https URL.`,
      );
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
    const testConfigs = testConfigsWithKeyOff(tree, project.root, [
      'app',
      'auth',
      'enabled',
    ]);

    const configPath = path.join(
      project.root,
      'src/main/resources/application.yaml',
    );
    const configFile = tree.read(configPath, 'utf-8');
    if (!configFile) {
      throw new Error(`Configuration file not found at ${configPath}`);
    }
    const config = parseYaml(configPath, configFile);
    const { protocol, hostname } = new URL(options.issuer);
    // A JVM does not trust the development certificate of an https issuer on localhost.
    config.setIn(
      ['app', 'ssl-verify'],
      !(protocol === 'https:' && hostname === 'localhost'),
    );
    const auth = config.createNode({
      enabled: true,
      issuer: options.issuer,
      ...(options.audience ? { audience: options.audience } : {}),
      'public-endpoints': [],
    }) as YAMLMap;
    // The comment follows the last key at the indentation of the app.auth keys, so the removal of "# " turns the bypass on.
    auth.comment = ' bypass-header: X-Bypass-Auth';
    config.setIn(['app', 'auth'], auth);
    tree.write(configPath, config.toString());
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
