import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  Tree,
  addProjectConfiguration,
  generateFiles,
  logger,
  readProjectConfiguration,
} from '@nx/devkit';
import { readFileSync } from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';

import { AUTH_PEOPLE_FEATURE, authPeopleFeature } from './auth-people';
import { authLoginFeature } from '../feature-auth-login/auth-login';
import { runFeature } from '../feature/run-feature';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const confirm = vi.hoisted(() => vi.fn());
vi.mock('@inquirer/prompts', () => ({ confirm }));

const isInteractive = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../shared/utils/interactive', () => ({ isInteractive }));

const serverRoot = 'test-project';
const javaRoot = `${serverRoot}/src/main/java/com/example`;
const javaTestRoot = `${serverRoot}/src/test/java/com/example`;
const configDir = `${javaRoot}/config`;
const yamlPath = `${serverRoot}/src/main/resources/application.yaml`;
const pomPath = `${serverRoot}/pom.xml`;
const docPath = `${serverRoot}/AUTH-PEOPLE.md`;
const pickerFile = 'src/components/person-picker.tsx';
const frontendTemplates = path.join(__dirname, '..', 'frontend', 'files');

function starterPom(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>ca.uhn.hapi.fhir</groupId>
        <artifactId>hapi-fhir</artifactId>
        <version>8.12.0</version>
    </parent>
    <artifactId>hapi-fhir-jpaserver-starter</artifactId>
    <dependencies>
        <dependency>
            <groupId>ca.uhn.hapi.fhir</groupId>
            <artifactId>hapi-fhir-base</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

function copyFrontendTemplate(tree: Tree, frontendRoot: string, file: string) {
  tree.write(
    `${frontendRoot}/${file}`,
    readFileSync(path.join(frontendTemplates, 'common', file), 'utf-8'),
  );
}

/** A frontend integrated with the server, with the sign-in support of the shipped template and with or without the picker. */
function addFrontend(tree: Tree, name: string, withPicker = true) {
  addProjectConfiguration(tree, name, {
    root: name,
    projectType: 'application',
    targets: {
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
  copyFrontendTemplate(tree, name, 'src/lib/fhir-config.ts');
  copyFrontendTemplate(tree, name, 'src/components/sign-in-section.tsx');
  if (withPicker) {
    tree.write(`${name}/${pickerFile}`, 'export {};\n');
  }
}

function createServerTree(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(pomPath, starterPom());
  tree.write(yamlPath, 'hapi:\n  fhir:\n    fhir_version: R4\n');
  addProjectConfiguration(tree, 'server', {
    root: serverRoot,
    projectType: 'application',
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
  } as ServerProjectConfiguration);
  // The server integration files of the frontend generator, from the shipped templates.
  generateFiles(tree, path.join(frontendTemplates, 'server'), javaRoot, {
    packageBase: 'com.example',
  });
  addFrontend(tree, 'frontend');
  return tree;
}

function serverProject(tree: Tree): ServerProjectConfiguration {
  return readProjectConfiguration(tree, 'server') as ServerProjectConfiguration;
}

describe('auth-people feature', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createServerTree();
    isInteractive.mockReturnValue(false);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('install check', () => {
    const collect = () =>
      authPeopleFeature.collectOptions(tree, serverProject(tree), {});

    it('refuses when ConfigController.java does not read app.login.people', async () => {
      const file = `${configDir}/ConfigController.java`;
      tree.write(file, '@Value("${app.login.enabled:false}")\n');

      const result = collect();
      await expect(result).rejects.toThrow(file);
      await expect(result).rejects.toThrow(
        'Run "nx g nx-fhir:update-frontend --project=frontend"',
      );
    });

    it('refuses when no integrated frontend has src/components/person-picker.tsx', async () => {
      tree.delete(`frontend/${pickerFile}`);

      const result = collect();
      await expect(result).rejects.toThrow(pickerFile);
      await expect(result).rejects.toThrow(
        'nx g nx-fhir:update-frontend --project=frontend',
      );
    });

    it('installs with a browser frontend beside a frontend that has the picker', async () => {
      addFrontend(tree, 'browser', false);

      await expect(collect()).resolves.toEqual({});
    });
  });

  it('writes PeopleController, PeopleControllerTest, and AUTH-PEOPLE.md', async () => {
    await authPeopleFeature.apply(tree, serverProject(tree), {});

    for (const file of [
      `${javaRoot}/people/PeopleController.java`,
      `${javaTestRoot}/people/PeopleControllerTest.java`,
      docPath,
    ]) {
      const content = tree.read(file, 'utf-8');
      expect(content, `${file} should exist`).not.toBeNull();
      expect(content).not.toContain('<%');
    }
    expect(
      tree.read(`${javaRoot}/people/PeopleController.java`, 'utf-8'),
    ).toContain('package com.example.people;');
  });

  it('writes app.login.people.enabled and keeps the scope comment of auth-login under app.login.udap', async () => {
    await authLoginFeature.apply(tree, serverProject(tree), {});
    await authPeopleFeature.apply(tree, serverProject(tree), {});

    const yaml = parseDocument(
      (tree.read(yamlPath, 'utf-8') as string).replace('# scope', 'scope'),
    );
    expect(yaml.getIn(['app', 'login', 'udap', 'scope'])).toBe(
      'openid fhirUser launch/patient patient/*.cruds user/*.cruds',
    );
    expect(yaml.getIn(['app', 'login', 'people', 'enabled'])).toBe(true);
  });

  it('writes AUTH-PEOPLE.md with the key, the endpoint, the warning, and no em-dash', async () => {
    await authPeopleFeature.apply(tree, serverProject(tree), {});

    const doc = tree.read(docPath, 'utf-8') as string;
    for (const text of [
      'app.login.people.enabled',
      '/auth/people',
      'X-App-Request',
      'loginHint',
      'skipForm',
      'hl7fast_signin=auto',
    ]) {
      expect(doc).toContain(text);
    }
    expect(doc).toMatch(/^WARNING:/m);
    expect(doc).not.toMatch(/[;—]/);
    expect(doc).not.toMatch(/\b(now|previously|no longer|new|again)\b/i);
    expect(doc).not.toMatch(/\n\n\n/);
  });

  it('installs frontend-proxy and auth-login first and records auth-people with no options', async () => {
    await runFeature(tree, { feature: AUTH_PEOPLE_FEATURE, project: 'server' });

    const features = serverProject(tree).features;
    expect(Object.keys(features ?? {})).toEqual([
      'frontend-proxy',
      'auth-login',
      'auth-people',
    ]);
    expect(features?.['auth-people']).toEqual({ version: 1, options: {} });
  });
});
