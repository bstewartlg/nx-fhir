import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';

import { addPomDependency } from './pom-edit';

const POM_PATH = 'server/pom.xml';

// The ragged indentation copies the HAPI starter's dependencyManagement block,
// so a test fails if that block ever leaks into the computed indentation.
const DEPENDENCY_MANAGEMENT = [
  '    <dependencyManagement>',
  '       <dependencies>',
  '            <dependency>',
  '               <groupId>org.glassfish.jaxb</groupId>',
  '               <artifactId>jaxb-runtime</artifactId>',
  '           </dependency>',
  '       </dependencies>',
  '    </dependencyManagement>',
  '',
].join('\n');

const PROJECT_DEPENDENCIES = [
  '    <dependencies>',
  '',
  '        <dependency>',
  '            <groupId>ca.uhn.hapi.fhir</groupId>',
  '            <artifactId>hapi-fhir-base</artifactId>',
  '        </dependency>',
  '',
  '    </dependencies>',
  '',
].join('\n');

const BUILD = ['    <build>', '    </build>', ''].join('\n');

const PROFILES = [
  '    <profiles>',
  '        <profile>',
  '            <id>boot</id>',
  '            <dependencies>',
  '                <dependency>',
  '                    <artifactId>spring-boot-starter-web</artifactId>',
  '                </dependency>',
  '            </dependencies>',
  '        </profile>',
  '    </profiles>',
].join('\n');

function starterPom({ dependencies = true } = {}): string {
  return [
    '<project>\n',
    DEPENDENCY_MANAGEMENT,
    dependencies ? PROJECT_DEPENDENCIES : '',
    BUILD,
    `${PROFILES}\n`,
    '</project>\n',
  ].join('');
}

const OTEL_DEPENDENCY = [
  '<dependency>',
  '    <groupId>io.opentelemetry.instrumentation</groupId>',
  '    <artifactId>opentelemetry-instrumentation-api</artifactId>',
  '</dependency>',
].join('\n');

function treeWithPom(pom: string): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(POM_PATH, pom);
  return tree;
}

function readPom(tree: Tree): string {
  return tree.read(POM_PATH, 'utf-8') ?? '';
}

describe('addPomDependency', () => {
  it('inserts before the project dependencies close, not the dependencyManagement one', () => {
    const tree = treeWithPom(starterPom());

    expect(addPomDependency(tree, POM_PATH, OTEL_DEPENDENCY)).toBe(true);

    const pom = readPom(tree);
    const snippet = pom.indexOf('opentelemetry-instrumentation-api');
    expect(snippet).toBeGreaterThan(pom.indexOf('</dependencyManagement>'));
    expect(snippet).toBeLessThan(pom.indexOf('<build>'));
  });

  it('matches the indentation of the preceding <dependency> element', () => {
    const tree = treeWithPom(starterPom());
    const templateLiteralSnippet = `
      <dependency>
          <groupId>io.opentelemetry.instrumentation</groupId>

          <artifactId>opentelemetry-instrumentation-api</artifactId>
      </dependency>
    `;

    addPomDependency(tree, POM_PATH, templateLiteralSnippet);

    expect(readPom(tree)).toContain(
      [
        '        </dependency>',
        '',
        '        <dependency>',
        '            <groupId>io.opentelemetry.instrumentation</groupId>',
        '',
        '            <artifactId>opentelemetry-instrumentation-api</artifactId>',
        '        </dependency>',
        '    </dependencies>',
        '    <build>',
      ].join('\n'),
    );
  });

  it('opens a dependencies element written on one line', () => {
    const tree = treeWithPom(
      '<project>\n    <dependencies></dependencies>\n    <build></build>\n</project>\n',
    );

    addPomDependency(tree, POM_PATH, OTEL_DEPENDENCY);

    expect(readPom(tree)).toBe(
      [
        '<project>',
        '    <dependencies>',
        '        <dependency>',
        '            <groupId>io.opentelemetry.instrumentation</groupId>',
        '            <artifactId>opentelemetry-instrumentation-api</artifactId>',
        '        </dependency>',
        '    </dependencies>',
        '    <build></build>',
        '</project>',
        '',
      ].join('\n'),
    );
  });

  it('returns false and leaves the pom byte-identical when the artifactId is present', () => {
    const original = starterPom();
    const tree = treeWithPom(original);
    const present = [
      '<dependency>',
      '    <groupId>ca.uhn.hapi.fhir</groupId>',
      '    <artifactId>hapi-fhir-base</artifactId>',
      '</dependency>',
    ].join('\n');

    expect(addPomDependency(tree, POM_PATH, present)).toBe(false);
    expect(readPom(tree)).toBe(original);
  });

  it('adds an artifact that only an XML comment in the project dependencies names', () => {
    const commentedOut = [
      '        <!--',
      '        <dependency>',
      '            <groupId>io.opentelemetry.instrumentation</groupId>',
      '            <artifactId>opentelemetry-instrumentation-api</artifactId>',
      '        </dependency>',
      '        -->',
    ];
    const tree = treeWithPom(
      [
        '<project>',
        '    <dependencies>',
        ...commentedOut,
        '    </dependencies>',
        '    <build></build>',
        '</project>',
        '',
      ].join('\n'),
    );

    expect(addPomDependency(tree, POM_PATH, OTEL_DEPENDENCY)).toBe(true);
    expect(readPom(tree)).toBe(
      [
        '<project>',
        '    <dependencies>',
        ...commentedOut,
        '        <dependency>',
        '            <groupId>io.opentelemetry.instrumentation</groupId>',
        '            <artifactId>opentelemetry-instrumentation-api</artifactId>',
        '        </dependency>',
        '    </dependencies>',
        '    <build></build>',
        '</project>',
        '',
      ].join('\n'),
    );
  });

  it('adds an artifact that only dependencyManagement declares', () => {
    const tree = treeWithPom(starterPom());
    const managed = [
      '<dependency>',
      '    <groupId>org.glassfish.jaxb</groupId>',
      '    <artifactId>jaxb-runtime</artifactId>',
      '</dependency>',
    ].join('\n');

    expect(addPomDependency(tree, POM_PATH, managed)).toBe(true);
    expect(readPom(tree)).toContain(
      '            <artifactId>jaxb-runtime</artifactId>\n        </dependency>\n    </dependencies>',
    );
  });

  it('throws when the pom has no </dependencies> before <build>', () => {
    const managementOnly = treeWithPom(starterPom({ dependencies: false }));
    const profileOnly = treeWithPom(
      `<project>\n${BUILD}${PROFILES}\n</project>\n`,
    );

    expect(() =>
      addPomDependency(managementOnly, POM_PATH, OTEL_DEPENDENCY),
    ).toThrow(/no project <dependencies> element/);
    expect(() =>
      addPomDependency(profileOnly, POM_PATH, OTEL_DEPENDENCY),
    ).toThrow(/no project <dependencies> element/);
    expect(() =>
      addPomDependency(
        createTreeWithEmptyWorkspace(),
        POM_PATH,
        OTEL_DEPENDENCY,
      ),
    ).toThrow(/no project <dependencies> element/);
  });

  it('throws when the snippet has no artifactId', () => {
    const tree = treeWithPom(starterPom());

    expect(() =>
      addPomDependency(tree, POM_PATH, '<dependency></dependency>'),
    ).toThrow(/<artifactId>/);
  });
});
