import { addProjectConfiguration, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { getIntegratedFrontends } from './frontend-integration';

function addProject(tree: Tree, name: string, serverRoot?: string) {
  addProjectConfiguration(tree, name, {
    root: name,
    targets:
      serverRoot === undefined
        ? {}
        : {
            'copy-to-server': {
              executor: 'nx:run-commands',
              options: {
                commands: [
                  `rimraf --glob "../${serverRoot}/src/main/resources/static/*"`,
                  `cpy "dist/**" "../${serverRoot}/src/main/resources/static" --cwd=.`,
                ],
              },
            },
          },
  });
}

describe('getIntegratedFrontends', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    addProject(tree, 'server');
  });

  it('returns the frontends whose copy-to-server target points to the server root', () => {
    addProject(tree, 'frontend', 'server');
    addProject(tree, 'admin', 'server');
    addProject(tree, 'other', 'other-server');
    addProject(tree, 'plain');

    expect(
      getIntegratedFrontends(tree, 'server')
        .map((project) => project.name)
        .sort(),
    ).toEqual(['admin', 'frontend']);
  });

  it('returns an empty list for a server with no frontend', () => {
    addProject(tree, 'other', 'other-server');

    expect(getIntegratedFrontends(tree, 'server')).toEqual([]);
  });
});
