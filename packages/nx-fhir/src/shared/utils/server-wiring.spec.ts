import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree, generateFiles } from '@nx/devkit';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'path';

import {
  detectApplicationClass,
  ensureServerWiring,
  listTemplateOutputs,
} from './server-wiring';

function applicationSource(javaPackage: string, className = 'Application'): string {
  return [
    `package ${javaPackage};`,
    '',
    'import org.springframework.boot.autoconfigure.SpringBootApplication;',
    '',
    '@SpringBootApplication',
    `public class ${className} {}`,
    '',
  ].join('\n');
}

function createServerTree(applicationPackage?: string): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('test-project/pom.xml', '<project></project>');
  if (applicationPackage) {
    const packagePath = applicationPackage.replace(/\./g, '/');
    tree.write(
      `test-project/src/main/java/${packagePath}/Application.java`,
      applicationSource(applicationPackage),
    );
  }
  return tree;
}

describe('listTemplateOutputs', () => {
  let sourceDir: string;

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('predicts the path generateFiles writes for a __key__ file name', () => {
    sourceDir = mkdtempSync(path.join(tmpdir(), 'nx-fhir-templates-'));
    mkdirSync(path.join(sourceDir, '__packageBase__'));
    writeFileSync(
      path.join(sourceDir, '__packageBase__', '__packageBase__Config.java.template'),
      'package <%= packageBase %>;\n',
    );

    const substitutions = { packageBase: 'com.example' };
    const predicted = listTemplateOutputs(sourceDir, substitutions).map((relative) =>
      path.join('test-project', relative),
    );

    const tree = createTreeWithEmptyWorkspace();
    generateFiles(tree, sourceDir, 'test-project', substitutions);

    expect(predicted).toEqual(['test-project/com.example/com.exampleConfig.java']);
    expect(tree.exists(predicted[0])).toBe(true);
  });
});

describe('detectApplicationClass', () => {
  it('finds the annotated class in the server sources', () => {
    const tree = createServerTree('com.acme.fhir');
    expect(detectApplicationClass(tree, 'test-project')).toBe(
      'com.acme.fhir.Application',
    );
  });

  it('falls back to the HAPI starter class when no annotated class exists', () => {
    const tree = createServerTree();
    expect(detectApplicationClass(tree, 'test-project')).toBe(
      'ca.uhn.fhir.jpa.starter.Application',
    );
  });
});

describe('ensureServerWiring', () => {
  it('throws when the package base sits outside the application package', () => {
    const tree = createServerTree('com.acme.boot');

    expect(() =>
      ensureServerWiring(tree, { root: 'test-project', packageBase: 'com.acme' }),
    ).toThrow(/'com\.acme\.boot'.*'com\.acme'/s);
  });

  it('accepts any package base under the HAPI starter application', () => {
    const tree = createServerTree('ca.uhn.fhir.jpa.starter');

    ensureServerWiring(tree, { root: 'test-project', packageBase: 'com.acme' });

    expect(
      tree.exists('test-project/src/main/java/com/acme/common/BaseProvider.java'),
    ).toBe(true);
  });

  it('accepts a package base under a repackaged application', () => {
    const tree = createServerTree('com.acme.fhir');

    ensureServerWiring(tree, {
      root: 'test-project',
      packageBase: 'com.acme.fhir.publish',
    });

    expect(
      tree.exists(
        'test-project/src/main/java/com/acme/fhir/publish/common/BaseProvider.java',
      ),
    ).toBe(true);
  });

  it('accepts a package base that custom-bean-packages covers', () => {
    const tree = createServerTree('com.acme.boot');
    tree.write(
      'test-project/src/main/resources/application.yaml',
      'hapi:\n  fhir:\n    custom-bean-packages: com.other.beans,com.acme.generated\n',
    );

    ensureServerWiring(tree, {
      root: 'test-project',
      packageBase: 'com.acme.generated.publish',
    });

    expect(
      tree.exists(
        'test-project/src/main/java/com/acme/generated/publish/common/BaseProvider.java',
      ),
    ).toBe(true);
  });

  it('throws when custom-bean-packages names an unrelated package', () => {
    const tree = createServerTree('com.acme.boot');
    tree.write(
      'test-project/src/main/resources/application.yaml',
      'hapi:\n  fhir:\n    custom-bean-packages: com.other.beans\n',
    );

    expect(() =>
      ensureServerWiring(tree, { root: 'test-project', packageBase: 'com.acme' }),
    ).toThrow(/'com\.acme\.boot'.*'com\.acme'/s);
  });

  it('leaves an existing wiring file byte-identical', () => {
    const tree = createServerTree('ca.uhn.fhir.jpa.starter');
    const existing = 'test-project/src/main/java/com/acme/common/BaseProvider.java';
    tree.write(existing, 'hand written');

    ensureServerWiring(tree, { root: 'test-project', packageBase: 'com.acme' });

    expect(tree.read(existing, 'utf-8')).toBe('hand written');
  });
});
