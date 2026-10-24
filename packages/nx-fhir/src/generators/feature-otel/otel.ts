import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import { confirm, input } from '@inquirer/prompts';
import * as path from 'path';

import { FeatureDefinition } from '../feature/types';
import { parseBooleanOption } from '../feature/options';
import { updateServerYaml } from '../../shared/utils';
import { addPomDependency } from '../../shared/utils/pom-edit';
import {
  ensureServerWiring,
  listTemplateOutputs,
} from '../../shared/utils/server-wiring';
import { isInteractive } from '../../shared/utils/interactive';
import { OTEL_JAVAAGENT_VERSION } from '../../shared/constants/versions';

// serviceName becomes the Grafana dashboard uid, which rejects dots and names over 40 characters.
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

// No version: the HAPI FHIR parent pom imports the OpenTelemetry instrumentation BOM from 8.0.0.
const DEPENDENCY_XML = `
<dependency>
    <groupId>io.opentelemetry.instrumentation</groupId>
    <artifactId>opentelemetry-instrumentation-api</artifactId>
</dependency>`;

// No version: the same BOM manages the OpenTelemetry API, which the request counter uses.
const API_DEPENDENCY_XML = `
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-api</artifactId>
</dependency>`;

interface OtelOptions {
  serviceName: string;
  dashboard: boolean;
  compose: boolean;
  serve: boolean;
}

async function collectToggle(
  name: string,
  provided: unknown,
  message: string,
): Promise<boolean> {
  if (provided !== undefined) {
    return parseBooleanOption(name, provided);
  }
  return isInteractive() ? confirm({ message, default: true }) : true;
}

export const otelFeature: FeatureDefinition = {
  name: 'otel',
  description:
    'Tag HAPI requests with OpenTelemetry routes and add a baseline Grafana dashboard',
  featureVersion: 1,
  // The HAPI parent pom manages the OpenTelemetry instrumentation versions from this release.
  minHapiVersion: '8.0.0',

  async collectOptions(tree, project, provided) {
    const projectName = project.name ?? '';
    const serviceName =
      provided.serviceName !== undefined
        ? String(provided.serviceName)
        : isInteractive()
          ? await input({
              message:
                'Service name for telemetry (the service.name attribute and the Grafana dashboard uid):',
              default: projectName,
            })
          : projectName;
    if (!SERVICE_NAME_PATTERN.test(serviceName)) {
      throw new Error(
        `Invalid serviceName '${serviceName}'. Use up to 40 letters, digits, _ or - (it becomes the Grafana dashboard uid)`,
      );
    }

    const options: OtelOptions = {
      serviceName,
      dashboard: await collectToggle(
        'dashboard',
        provided.dashboard,
        'Write a baseline Grafana dashboard?',
      ),
      compose: await collectToggle(
        'compose',
        provided.compose,
        'Write docker-compose.otel.yml with a local Grafana LGTM stack?',
      ),
      serve: await collectToggle(
        'serve',
        provided.serve,
        'Enable nx serve --otel to run the server with the OpenTelemetry agent?',
      ),
    };
    return options as unknown as Record<string, unknown>;
  },

  async apply(tree: Tree, project, rawOptions) {
    const options = rawOptions as unknown as OtelOptions;
    const packagePath = project.packageBase.replace(/\./g, '/');
    const fileNameSubstitutions = {
      packageBase: project.packageBase,
      serviceName: options.serviceName,
    };
    const substitutions = {
      ...fileNameSubstitutions,
      projectName: project.name,
      dashboard: options.dashboard,
      compose: options.compose,
      serve: options.serve,
      agentVersion: OTEL_JAVAAGENT_VERSION,
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
    if (options.compose || options.serve) {
      groups.push(['otel', path.join(project.root, 'otel')]);
    }
    if (options.dashboard) {
      groups.push(['dashboard', path.join(project.root, 'otel')]);
    }
    if (options.compose) {
      groups.push(['compose', project.root]);
    }
    const collisions = groups
      .flatMap(([group, target]) =>
        listTemplateOutputs(
          path.join(__dirname, 'files', group),
          fileNameSubstitutions,
        ).map((relative) => path.join(target, relative)),
      )
      .filter((file) => tree.exists(file));
    if (collisions.length > 0) {
      throw new Error(
        `feature otel would overwrite files that already exist:\n${collisions.join(
          '\n',
        )}\nMove or remove them before installing the feature.`,
      );
    }

    // The pre-check above reports every collision at once; the strategy is the backstop for a
    // path it fails to predict.
    for (const [group, target] of groups) {
      generateFiles(tree, path.join(__dirname, 'files', group), target, substitutions, {
        overwriteStrategy: OverwriteStrategy.ThrowIfExisting,
      });
    }

    addPomDependency(tree, path.join(project.root, 'pom.xml'), DEPENDENCY_XML);
    addPomDependency(tree, path.join(project.root, 'pom.xml'), API_DEPENDENCY_XML);
    updateServerYaml(project.root, tree, 'telemetry.capture-query-strings', false);
    updateServerYaml(project.root, tree, 'telemetry.resource-types', []);
  },
};
