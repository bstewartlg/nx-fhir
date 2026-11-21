import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import * as path from 'node:path';

import { FeatureDefinition } from '../feature/types';
import {
  AUTH_RESOURCE_FEATURE,
  parseYaml,
  setAuthMap,
  testConfigsWithKeyOff,
} from '../feature-auth-resource/auth-resource';
import { AUTH_SCOPES_FEATURE } from '../feature-auth-scopes/auth-scopes';
import {
  detectApplicationClass,
  listTemplateOutputs,
} from '../../shared/utils/server-wiring';

/** The starter value of app.auth.smart.capabilities. */
export const SMART_CAPABILITIES = [
  'launch-standalone',
  'client-confidential-symmetric',
  'sso-openid-connect',
  'permission-offline',
  'permission-patient',
  'permission-user',
  'permission-v1',
  'permission-v2',
];

export const authSmartFeature: FeatureDefinition = {
  name: 'auth-smart',
  description:
    'Publish the SMART configuration at /fhir/.well-known/smart-configuration',
  featureVersion: 1,
  minHapiVersion: '8.8.0',
  requires: [AUTH_RESOURCE_FEATURE, AUTH_SCOPES_FEATURE],

  async collectOptions() {
    return {};
  },

  async apply(tree: Tree, project) {
    const packagePath = project.packageBase.replace(/\./g, '/');
    const applicationClassFqn = detectApplicationClass(tree, project.root);
    const substitutions = {
      packageBase: project.packageBase,
      applicationClassFqn,
      applicationClassName: applicationClassFqn.split('.').pop() as string,
      fhirVersion: project.fhirVersion,
    };

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
        `feature auth-smart would overwrite files that already exist:\n${collisions.join(
          '\n',
        )}\nMove or remove them before installing the feature.`,
      );
    }

    // Each step that can refuse runs before the first write, so a refusal leaves the tree unchanged.
    const testConfigs = testConfigsWithKeyOff(tree, project.root, [
      'app',
      'auth',
      'smart',
      'enabled',
    ]);

    const configPath = path.join(
      project.root,
      'src/main/resources/application.yaml',
    );
    const config = parseYaml(configPath, tree.read(configPath, 'utf-8') ?? '');
    setAuthMap(config, 'smart', {
      enabled: true,
      capabilities: SMART_CAPABILITIES,
    });

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
