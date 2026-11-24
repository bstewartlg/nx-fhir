import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import { confirm } from '@inquirer/prompts';
import * as path from 'path';

import { FeatureDefinition } from '../feature/types';
import { parseBooleanOption } from '../feature/options';
import { ServerProjectConfiguration } from '../../shared/models';
import { updateServerYaml } from '../../shared/utils';
import { getIntegratedFrontends } from '../../shared/utils/frontend-integration';
import { isInteractive } from '../../shared/utils/interactive';
import { addPomDependency } from '../../shared/utils/pom-edit';
import {
  detectApplicationClass,
  listTemplateOutputs,
} from '../../shared/utils/server-wiring';

export const FRONTEND_PROXY_FEATURE = 'frontend-proxy';

// No version: the HAPI FHIR parent pom manages it.
const DEPENDENCY_XML = `
<dependency>
    <groupId>org.apache.httpcomponents.client5</groupId>
    <artifactId>httpclient5</artifactId>
</dependency>`;

interface FrontendProxyOptions {
  passthrough: boolean;
}

/**
 * Adds the line KEY=value to the .env.development file of a frontend. A line
 * for the key that is already there stays as it is.
 */
export function writeDevEnvLine(
  tree: Tree,
  frontendRoot: string,
  key: string,
  value: string,
): void {
  const envPath = path.join(frontendRoot, '.env.development');
  const content = tree.read(envPath, 'utf-8') ?? '';
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${escapedKey}=`, 'm').test(content)) {
    return;
  }
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  tree.write(envPath, `${content}${separator}${key}=${value}\n`);
}

/**
 * Adds the Vite development proxy target to the .env.development file of a
 * frontend. A DEV_SERVER_URL line that is already there stays as it is.
 */
export function writeDevServerEnv(tree: Tree, frontendRoot: string): void {
  writeDevEnvLine(tree, frontendRoot, 'DEV_SERVER_URL', 'http://localhost:8080');
}

/**
 * Refuses the install when the frontend or the server integration files have
 * no proxy support. The proxy needs the frontend to send its requests through
 * it, and the integration files to expose the proxy configuration and to keep
 * other origins out of /proxy.
 */
function assertProxySupport(
  tree: Tree,
  project: ServerProjectConfiguration,
): void {
  const frontends = getIntegratedFrontends(tree, project.root);
  if (frontends.length === 0) {
    throw new Error(
      `Feature '${FRONTEND_PROXY_FEATURE}' found no frontend project that is integrated with project '${project.name}'. ` +
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
    const fhirConfig = tree.read(fhirConfigPath, 'utf-8') ?? '';
    if (!/\bexport\s+(?:function|const)\s+toRequestUrl\b/.test(fhirConfig)) {
      throw new Error(
        `Feature '${FRONTEND_PROXY_FEATURE}' cannot install: frontend project '${frontend.name}' has no proxy support. ` +
          `${fhirConfigPath} does not export toRequestUrl. ` +
          `Run "nx g nx-fhir:update-frontend --project=${frontend.name}" first.`,
      );
    }
  }

  const configDir = path.join(
    project.root,
    'src',
    'main',
    'java',
    project.packageBase.replace(/\./g, '/'),
    'config',
  );
  const readConfigFile = (name: string) =>
    tree.read(path.join(configDir, name), 'utf-8');
  const problems: string[] = [];
  if (!readConfigFile('ConfigController.java')?.includes('app.proxy')) {
    problems.push(
      'ConfigController.java is absent or does not read app.proxy.',
    );
  }
  if (readConfigFile('FhirServers.java') === null) {
    problems.push('FhirServers.java is absent.');
  }
  const cors = readConfigFile('GlobalCorsConfiguration.java');
  if (cors !== null) {
    // Spring uses the first mapping that matches, so a /proxy mapping after /** never applies.
    const proxyMapping = cors.indexOf('addMapping("/proxy")');
    const allPathsMapping = cors.indexOf('addMapping("/**")');
    if (proxyMapping < 0) {
      problems.push('GlobalCorsConfiguration.java has no mapping for /proxy.');
    } else if (allPathsMapping >= 0 && allPathsMapping < proxyMapping) {
      problems.push('GlobalCorsConfiguration.java registers /proxy after /**.');
    }
  }
  if (problems.length > 0) {
    const commands = frontends.map(
      (frontend) => `nx g nx-fhir:update-frontend --project=${frontend.name}`,
    );
    throw new Error(
      `Feature '${FRONTEND_PROXY_FEATURE}' cannot install: the server integration files in ${configDir} have no proxy support.\n` +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        `\nRun "${commands.join('" and "')}", then resolve each merge conflict in these files.`,
    );
  }
}

export const frontendProxyFeature: FeatureDefinition = {
  name: FRONTEND_PROXY_FEATURE,
  description:
    'Add a same-origin proxy that the integrated frontend uses for requests to other FHIR servers',
  featureVersion: 1,
  // The proxy uses the ClientHttpRequestFactoryBuilder API of Spring Boot 3.4. Releases before 8.8.0 are not verified.
  minHapiVersion: '8.8.0',

  async collectOptions(tree, project, provided) {
    assertProxySupport(tree, project);

    const passthrough =
      provided.passthrough !== undefined
        ? parseBooleanOption('passthrough', provided.passthrough)
        : isInteractive()
          ? await confirm({
              message:
                'Permit requests to any public server that the user enters?',
              default: false,
            })
          : false;
    const options: FrontendProxyOptions = { passthrough };
    return options as unknown as Record<string, unknown>;
  },

  async apply(tree: Tree, project, rawOptions) {
    const options = rawOptions as unknown as FrontendProxyOptions;
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
        `feature ${FRONTEND_PROXY_FEATURE} would overwrite files that already exist:\n${collisions.join(
          '\n',
        )}\nMove or remove them before installing the feature.`,
      );
    }

    // The pom and yaml edits come before the other writes, because each of them can refuse.
    // Each refuses before its own write. A yaml refusal puts back the pom bytes and the yaml
    // bytes, so a refusal leaves the tree unchanged.
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
      updateServerYaml(project.root, tree, 'app.proxy.enabled', true);
      updateServerYaml(
        project.root,
        tree,
        'app.proxy.passthrough',
        options.passthrough,
      );
      // Behind a proxy that ends TLS, the server then sees the https origin of the page, and the
      // CORS check of /proxy accepts its Origin header.
      updateServerYaml(
        project.root,
        tree,
        'server.forward-headers-strategy',
        'native',
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

    for (const frontend of getIntegratedFrontends(tree, project.root)) {
      writeDevServerEnv(tree, frontend.root);
    }
  },
};
