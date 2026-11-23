import { generateFiles, OverwriteStrategy, Tree } from '@nx/devkit';
import * as path from 'path';

import { FeatureDefinition } from '../feature/types';
import { AUTH_LOGIN_FEATURE } from '../feature-auth-login/auth-login';
import { ServerProjectConfiguration } from '../../shared/models';
import { updateServerYaml } from '../../shared/utils';
import { getIntegratedFrontends } from '../../shared/utils/frontend-integration';
import { listTemplateOutputs } from '../../shared/utils/server-wiring';

export const AUTH_PEOPLE_FEATURE = 'auth-people';

const PICKER_FILE = 'src/components/person-picker.tsx';

/**
 * Refuses the install when /config.js cannot tell the frontend that this
 * server lists its people, or when no integrated frontend has the picker.
 */
function assertPickerSupport(
  tree: Tree,
  project: ServerProjectConfiguration,
): void {
  const frontends = getIntegratedFrontends(tree, project.root);
  const commands = frontends
    .map((frontend) => `nx g nx-fhir:update-frontend --project=${frontend.name}`)
    .join('" and "');

  const configControllerPath = path.join(
    project.root,
    'src',
    'main',
    'java',
    project.packageBase.replace(/\./g, '/'),
    'config',
    'ConfigController.java',
  );
  if (!tree.read(configControllerPath, 'utf-8')?.includes('app.login.people')) {
    throw new Error(
      `Feature '${AUTH_PEOPLE_FEATURE}' cannot install: ${configControllerPath} is absent or does not read app.login.people.\n` +
        `Run "${commands}", then resolve each merge conflict in this file.`,
    );
  }

  if (
    !frontends.some((frontend) =>
      tree.exists(path.join(frontend.root, PICKER_FILE)),
    )
  ) {
    throw new Error(
      `Feature '${AUTH_PEOPLE_FEATURE}' cannot install: no frontend project that is integrated with project '${project.name}' has ${PICKER_FILE}. ` +
        `Only the 'clinical' frontend template has this file. For a frontend of that template, run "${commands}" first.`,
    );
  }
}

export const authPeopleFeature: FeatureDefinition = {
  name: AUTH_PEOPLE_FEATURE,
  description:
    'Let a tester sign in as a Patient or a Practitioner of this server from the sign-in page of the integrated clinical frontend',
  featureVersion: 1,
  minHapiVersion: '8.8.0',
  requires: [AUTH_LOGIN_FEATURE],

  async collectOptions(tree, project) {
    assertPickerSupport(tree, project);
    return {};
  },

  async apply(tree: Tree, project) {
    const packagePath = project.packageBase.replace(/\./g, '/');
    const substitutions = { packageBase: project.packageBase };

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
        `feature ${AUTH_PEOPLE_FEATURE} would overwrite files that already exist:\n${collisions.join(
          '\n',
        )}\nMove or remove them before installing the feature.`,
      );
    }

    // The yaml edit can refuse, so it comes before the first file write.
    updateServerYaml(project.root, tree, 'app.login.people.enabled', true);

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
