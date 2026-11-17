import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import { input } from '@inquirer/prompts';
import * as path from 'path';

import { FeatureDefinition } from '../feature/types';
import {
  AUTH_RESOURCE_FEATURE,
  parseYaml,
  setAuthMap,
  testConfigsWithKeyOff,
} from '../feature-auth-resource/auth-resource';
import { ensureGitignoreEntries } from '../../shared/utils';
import { isInteractive } from '../../shared/utils/interactive';
import {
  detectApplicationClass,
  listTemplateOutputs,
} from '../../shared/utils/server-wiring';

interface AuthUdapOptions {
  certFile: string;
}

/** The file name of a fetched certificate in the working directory of the server. */
const SAVED_CERTIFICATE = 'generated-cert.pfx';

/** The UDAP lists of the FAST security server, in the order of the app.auth.udap keys. */
const UDAP_LISTS = {
  'profiles-supported': ['udap_dcr', 'udap_authn', 'udap_authz', 'udap_to'],
  'grant-types-supported': [
    'authorization_code',
    'refresh_token',
    'client_credentials',
  ],
  'authorization-extensions-supported': ['hl7-b2b'],
  'authorization-extensions-required': [],
  'certifications-supported': [],
  'token-endpoint-auth-signing-alg-values-supported': [
    'RS256',
    'RS384',
    'ES256',
    'ES384',
  ],
  'registration-endpoint-jwt-signing-alg-values-supported': [
    'RS256',
    'RS384',
    'ES256',
    'ES384',
  ],
};

export const authUdapFeature: FeatureDefinition = {
  name: 'auth-udap',
  description: 'Publish signed UDAP metadata at /fhir/.well-known/udap',
  featureVersion: 1,
  minHapiVersion: '8.8.0',
  requires: [AUTH_RESOURCE_FEATURE],

  async collectOptions(tree, project, provided) {
    const certFile = (
      provided.certFile !== undefined
        ? String(provided.certFile)
        : isInteractive()
          ? await input({
              message:
                'Path of a PKCS#12 certificate file. Leave empty and the server fetches a test certificate from the issuer:',
            })
          : ''
    ).trim();

    const options: AuthUdapOptions = { certFile };
    return options as unknown as Record<string, unknown>;
  },

  async apply(tree: Tree, project, rawOptions) {
    const options = rawOptions as unknown as AuthUdapOptions;
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
        `feature auth-udap would overwrite files that already exist:\n${collisions.join(
          '\n',
        )}\nMove or remove them before installing the feature.`,
      );
    }

    // Each step that can refuse runs before the first write, so a refusal leaves the tree unchanged.
    const testConfigs = testConfigsWithKeyOff(tree, project.root, [
      'app',
      'auth',
      'udap',
      'enabled',
    ]);

    const configPath = path.join(
      project.root,
      'src/main/resources/application.yaml',
    );
    const config = parseYaml(configPath, tree.read(configPath, 'utf-8') ?? '');
    setAuthMap(config, 'udap', {
      enabled: true,
      ...(options.certFile
        ? { 'cert-file': options.certFile }
        : { 'fetch-cert': true }),
      ...UDAP_LISTS,
    });

    tree.write(configPath, config.toString());
    for (const [file, content] of testConfigs) {
      tree.write(file, content);
    }
    // The saved certificate holds a private key.
    ensureGitignoreEntries(tree, path.join(project.root, '.gitignore'), [
      SAVED_CERTIFICATE,
    ]);

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
