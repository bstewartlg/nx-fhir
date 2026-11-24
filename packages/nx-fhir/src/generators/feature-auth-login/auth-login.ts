import {
  detectPackageManager,
  generateFiles,
  logger,
  OverwriteStrategy,
  Tree,
} from '@nx/devkit';
import { confirm } from '@inquirer/prompts';
import * as path from 'path';
import { YAMLMap } from 'yaml';

import { FeatureDefinition } from '../feature/types';
import { parseBooleanOption } from '../feature/options';
import { parseYaml } from '../feature-auth-resource/auth-resource';
import {
  FRONTEND_PROXY_FEATURE,
  writeDevEnvLine,
} from '../feature-frontend-proxy/frontend-proxy';
import { ServerProjectConfiguration } from '../../shared/models';
import { updateServerYaml } from '../../shared/utils';
import { getIntegratedFrontends } from '../../shared/utils/frontend-integration';
import { isInteractive } from '../../shared/utils/interactive';
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

interface AuthLoginOptions {
  viteHttps: boolean;
  composeHttps: boolean;
}

export function httpsDefault(
  tree: Tree,
  project: ServerProjectConfiguration,
): boolean {
  const yamlPath = path.join(
    project.root,
    'src',
    'main',
    'resources',
    'application.yaml',
  );
  const text = tree.read(yamlPath, 'utf-8');
  if (text === null) {
    return true;
  }
  const issuer = parseYaml(yamlPath, text).getIn(['app', 'auth', 'issuer']);
  try {
    return new URL(String(issuer)).hostname !== 'localhost';
  } catch {
    return true;
  }
}

// The COPY lines of the Dockerfile in the parent directory of a frontend use paths from the workspace root,
// so the build context of the compose file is the workspace root.
export function composeTargets(
  tree: Tree,
  project: ServerProjectConfiguration,
): Array<{ directory: string; context: string; dockerfile?: string }> {
  const directories = new Set(
    getIntegratedFrontends(tree, project.root).map((frontend) =>
      path.posix.dirname(frontend.root.replace(/\\/g, '/')),
    ),
  );
  return [...directories]
    .filter((directory) => tree.exists(path.posix.join(directory, 'Dockerfile')))
    .map((directory) =>
      directory === '.'
        ? { directory, context: '.' }
        : {
            directory,
            context: path.posix.relative(directory, '.'),
            dockerfile: path.posix.join(directory, 'Dockerfile'),
          },
    );
}

async function collectHttpsOption(
  name: string,
  provided: unknown,
  message: string,
  defaultValue: boolean,
): Promise<boolean> {
  if (provided !== undefined) {
    return parseBooleanOption(name, provided);
  }
  return isInteractive()
    ? confirm({ message, default: defaultValue })
    : defaultValue;
}

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

  async collectOptions(tree, project, provided) {
    assertSignInSupport(tree, project);
    const defaultValue = httpsDefault(tree, project);
    const options: AuthLoginOptions = {
      viteHttps: await collectHttpsOption(
        'viteHttps',
        provided.viteHttps,
        'Serve the Vite dev server of the frontend over https?',
        defaultValue,
      ),
      composeHttps: await collectHttpsOption(
        'composeHttps',
        provided.composeHttps,
        'Write docker-compose.https.yml with the server behind an https proxy?',
        defaultValue,
      ),
    };
    return options as unknown as Record<string, unknown>;
  },

  async apply(tree: Tree, project, rawOptions) {
    const options = rawOptions as unknown as Partial<AuthLoginOptions>;
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
    const composeDir = path.join(__dirname, 'files', 'compose');
    const composeDirectories =
      options.composeHttps === true ? composeTargets(tree, project) : [];
    const collisions = [
      ...groups.flatMap(([group, target]) =>
        listTemplateOutputs(
          path.join(__dirname, 'files', group),
          substitutions,
        ).map((relative) => path.join(target, relative)),
      ),
      ...composeDirectories.flatMap(({ directory }) =>
        listTemplateOutputs(composeDir).map((relative) =>
          path.join(directory, relative),
        ),
      ),
    ].filter((file) => tree.exists(file));
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
        ' scope: openid fhirUser launch/patient patient/*.cruds user/*.cruds';
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
    const templateVars = {
      ...substitutions,
      viteHttps: options.viteHttps === true,
      // The document describes the compose file only when the install writes one.
      composeHttps: composeDirectories.length > 0,
      runner: detectPackageManager(tree.root) === 'bun' ? 'bunx' : 'npx',
    };
    for (const [group, target] of groups) {
      generateFiles(
        tree,
        path.join(__dirname, 'files', group),
        target,
        templateVars,
        {
          overwriteStrategy: OverwriteStrategy.ThrowIfExisting,
        },
      );
    }

    for (const { directory, context, dockerfile } of composeDirectories) {
      generateFiles(
        tree,
        composeDir,
        directory,
        { context, dockerfile: dockerfile ?? '' },
        { overwriteStrategy: OverwriteStrategy.ThrowIfExisting },
      );
    }
    if (options.composeHttps === true && composeDirectories.length === 0) {
      logger.warn(
        `No integrated frontend of project '${project.name}' has a Dockerfile in its parent directory, so the install writes no docker-compose.https.yml.`,
      );
    }

    if (options.viteHttps === true) {
      for (const frontend of getIntegratedFrontends(tree, project.root)) {
        writeDevEnvLine(tree, frontend.root, 'DEV_HTTPS', 'true');
        const viteConfig =
          tree.read(path.join(frontend.root, 'vite.config.ts'), 'utf-8') ?? '';
        if (!viteConfig.includes('DEV_HTTPS')) {
          logger.warn(
            `The vite.config.ts of frontend project '${frontend.name}' does not read DEV_HTTPS, so its Vite server uses http. ` +
              `Run "nx g nx-fhir:update-frontend --project=${frontend.name}" to add the https support.`,
          );
        }
      }
    }
  },
};
