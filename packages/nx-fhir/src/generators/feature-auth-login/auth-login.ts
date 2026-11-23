import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import * as path from 'path';
import { YAMLMap } from 'yaml';

import { FeatureDefinition } from '../feature/types';
import { parseYaml } from '../feature-auth-resource/auth-resource';
import { FRONTEND_PROXY_FEATURE } from '../feature-frontend-proxy/frontend-proxy';
import { ServerProjectConfiguration } from '../../shared/models';
import { updateServerYaml } from '../../shared/utils';
import { getIntegratedFrontends } from '../../shared/utils/frontend-integration';
import { addPomDependency } from '../../shared/utils/pom-edit';
import {
  detectApplicationClass,
  listTemplateOutputs,
} from '../../shared/utils/server-wiring';

export const AUTH_LOGIN_FEATURE = 'auth-login';

const DEPENDENCY_XML = `
<dependency>
    <groupId>com.nimbusds</groupId>
    <artifactId>oauth2-oidc-sdk</artifactId>
    <version>11.26</version>
</dependency>`;

/**
 * Refuses the install when the frontend or the server integration files have
 * no sign-in support. The frontend must mark its own requests with the app
 * header and show the sign-in section, and /config.js must tell the frontend
 * that this server offers sign-in.
 */
function assertSignInSupport(
  tree: Tree,
  project: ServerProjectConfiguration,
): void {
  const frontends = getIntegratedFrontends(tree, project.root);
  if (frontends.length === 0) {
    throw new Error(
      `Feature '${AUTH_LOGIN_FEATURE}' found no frontend project that is integrated with project '${project.name}'. ` +
        `Run the frontend generator and select '${project.name}' as its server first.`,
    );
  }

  for (const frontend of frontends) {
    const fhirConfigPath = path.join(
      frontend.root,
      'src',
      'lib',
      'fhir-config.ts',
    );
    const signInPath = path.join(
      frontend.root,
      'src',
      'components',
      'sign-in-section.tsx',
    );
    const fhirConfig = tree.read(fhirConfigPath, 'utf-8') ?? '';
    const problem = !/\bexport\s+const\s+APP_REQUEST_HEADER\b/.test(fhirConfig)
      ? `${fhirConfigPath} does not export APP_REQUEST_HEADER.`
      : !tree.exists(signInPath)
        ? `${signInPath} is absent.`
        : null;
    if (problem) {
      throw new Error(
        `Feature '${AUTH_LOGIN_FEATURE}' cannot install: frontend project '${frontend.name}' has no sign-in support. ` +
          `${problem} ` +
          `Run "nx g nx-fhir:update-frontend --project=${frontend.name}" first.`,
      );
    }
  }

  const configControllerPath = path.join(
    project.root,
    'src',
    'main',
    'java',
    project.packageBase.replace(/\./g, '/'),
    'config',
    'ConfigController.java',
  );
  if (!tree.read(configControllerPath, 'utf-8')?.includes('app.login')) {
    const commands = frontends.map(
      (frontend) => `nx g nx-fhir:update-frontend --project=${frontend.name}`,
    );
    throw new Error(
      `Feature '${AUTH_LOGIN_FEATURE}' cannot install: ${configControllerPath} is absent or does not read app.login.\n` +
        `Run "${commands.join('" and "')}", then resolve each merge conflict in this file.`,
    );
  }
}

export const authLoginFeature: FeatureDefinition = {
  name: AUTH_LOGIN_FEATURE,
  description:
    'Let the integrated frontend sign in at the authorization server of the selected FHIR server',
  featureVersion: 1,
  // The login classes use the HTTP clients of frontend-proxy. Releases before 8.8.0 are not verified.
  minHapiVersion: '8.8.0',
  requires: [FRONTEND_PROXY_FEATURE],

  async collectOptions(tree, project) {
    assertSignInSupport(tree, project);
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
        `feature ${AUTH_LOGIN_FEATURE} would overwrite files that already exist:\n${collisions.join(
          '\n',
        )}\nMove or remove them before installing the feature.`,
      );
    }

    // The pom and yaml edits come before the other writes, because each of them can refuse.
    // A yaml call can refuse after an earlier yaml call wrote its key, so a yaml refusal puts
    // back the pom bytes and the yaml bytes. A refusal then leaves the tree unchanged.
    const pomPath = path.join(project.root, 'pom.xml');
    const yamlPath = path.join(
      project.root,
      'src',
      'main',
      'resources',
      'application.yaml',
    );
    const pomBefore = tree.read(pomPath) as Buffer;
    const yamlBefore = tree.read(yamlPath);
    addPomDependency(tree, pomPath, DEPENDENCY_XML);
    try {
      // The auth features read the same key, so a value that the file has stays. With no file, updateServerYaml
      // refuses.
      if (
        !parseYaml(yamlPath, tree.read(yamlPath, 'utf-8') ?? '').hasIn([
          'app',
          'ssl-verify',
        ])
      ) {
        updateServerYaml(project.root, tree, 'app.ssl-verify', true);
      }
      updateServerYaml(project.root, tree, 'app.login.enabled', true);
      updateServerYaml(
        project.root,
        tree,
        'app.login.udap.client-name',
        project.name,
      );
      updateServerYaml(
        project.root,
        tree,
        'app.login.udap.contact',
        'mailto:admin@localhost',
      );
      updateServerYaml(
        project.root,
        tree,
        'app.login.udap.logo-uri',
        'https://build.fhir.org/icon-fhir-16.png',
      );
      const config = parseYaml(yamlPath, tree.read(yamlPath, 'utf-8') as string);
      // The comment follows the last key at the indentation of the app.login.udap keys, so the removal of "# " gives
      // app.login.udap.scope.
      (config.getIn(['app', 'login', 'udap'], true) as YAMLMap).comment =
        ' scope: openid fhirUser launch/patient patient/*.rs user/*.rs';
      tree.write(yamlPath, config.toString());
      updateServerYaml(
        project.root,
        tree,
        'server.servlet.session.cookie.same-site',
        'lax',
      );
      updateServerYaml(
        project.root,
        tree,
        'server.servlet.session.tracking-modes',
        'cookie',
      );
    } catch (error) {
      tree.write(pomPath, pomBefore);
      if (yamlBefore !== null) {
        tree.write(yamlPath, yamlBefore);
      }
      throw error;
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
