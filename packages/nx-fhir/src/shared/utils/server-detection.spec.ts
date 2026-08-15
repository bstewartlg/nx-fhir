import { describe, it, expect, beforeEach } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';

import {
  detectExistingServer,
  detectFhirVersionFromYaml,
  detectHapiReleaseCandidates,
  detectPackageBase,
  detectPomImageIdentity,
} from './server-detection';
import { FhirVersion } from '../models';

/** A pom naming the HAPI parent, optionally with the starter revision property. */
function hapiPom(base: string, revision?: string): string {
  const properties =
    revision === undefined
      ? ''
      : `  <properties>
    <hapi.fhir.jpa.server.starter.revision>${revision}</hapi.fhir.jpa.server.starter.revision>
  </properties>
`;
  return `<project>
  <artifactId>hapi-fhir-jpaserver-starter</artifactId>
  <parent>
    <groupId>ca.uhn.hapi.fhir</groupId>
    <artifactId>hapi-fhir</artifactId>
    <version>${base}</version>
  </parent>
${properties}</project>`;
}

function writeServer(
  tree: Tree,
  root: string,
  { pom = hapiPom('8.8.0', '1'), yaml = 'hapi:\n  fhir:\n    fhir_version: R4\n', yamlFile = 'application.yaml' } = {},
) {
  const prefix = root === '.' ? '' : `${root}/`;
  tree.write(`${prefix}pom.xml`, pom);
  tree.write(`${prefix}src/main/resources/${yamlFile}`, yaml);
}

describe('detectExistingServer', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('treats an empty directory argument as the workspace root', () => {
    writeServer(tree, '.');

    const detected = detectExistingServer(tree, '');

    expect(detected?.root).toBe('.');
    expect(detected?.hapiReleaseVersion).toBe('8.8.0-1');
  });

  it('accepts a server whose config uses the .yml extension', () => {
    writeServer(tree, 'server', {
      yamlFile: 'application.yml',
      yaml: 'hapi:\n  fhir:\n    fhir_version: R5\n',
    });

    const detected = detectExistingServer(tree, 'server');

    expect(detected?.root).toBe('server');
    expect(detected?.fhirVersion).toBe(FhirVersion.R5);
  });

  it('rejects a pom that has no Spring Boot application config beside it', () => {
    tree.write('server/pom.xml', hapiPom('8.8.0', '1'));

    expect(detectExistingServer(tree, 'server')).toBeNull();
  });

  it('rejects a directory with no pom at all', () => {
    tree.write('server/src/main/resources/application.yaml', 'hapi:\n');

    expect(detectExistingServer(tree, 'server')).toBeNull();
  });

  it('rejects a pom that does not reference HAPI', () => {
    writeServer(tree, 'server', {
      pom: '<project><artifactId>unrelated-service</artifactId></project>',
    });

    expect(detectExistingServer(tree, 'server')).toBeNull();
  });

  it('rejects the server when the pom exists but cannot be read', () => {
    writeServer(tree, 'server');
    // A pom present on the tree but unreadable must not be treated as a HAPI
    // server on the strength of its path alone.
    tree.read = ((path: string) =>
      path.endsWith('pom.xml') ? null : 'hapi:\n') as Tree['read'];

    expect(detectExistingServer(tree, 'server')).toBeNull();
  });

  it('detects the server but leaves the FHIR version unset when the config cannot be read', () => {
    writeServer(tree, 'server');
    const pom = hapiPom('8.8.0', '1');
    tree.read = ((path: string) =>
      path.endsWith('pom.xml') ? pom : null) as Tree['read'];

    const detected = detectExistingServer(tree, 'server');

    expect(detected?.root).toBe('server');
    expect(detected?.hapiReleaseVersion).toBe('8.8.0-1');
    expect(detected?.fhirVersion).toBeUndefined();
  });

  it('leaves the release unrecorded when the pom matches several curated revisions', () => {
    // Base 8.0.0 alone matches 8.0.0, 8.0.0-1 and 8.0.0-2.
    writeServer(tree, 'server', { pom: hapiPom('8.0.0') });

    const detected = detectExistingServer(tree, 'server');

    expect(detected?.hapiReleaseVersion).toBeUndefined();
    expect(detected?.hapiReleaseCandidates).toEqual([
      '8.0.0',
      '8.0.0-1',
      '8.0.0-2',
    ]);
  });
});

describe('detectPomImageIdentity', () => {
  it('ignores a parent that is not the HAPI parent', () => {
    const pom = `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.1</version>
  </parent>
</project>`;

    expect(detectPomImageIdentity(pom)).toBeUndefined();
  });

  it('returns nothing for a HAPI parent that declares no version', () => {
    const pom = `<project>
  <parent>
    <groupId>ca.uhn.hapi.fhir</groupId>
    <artifactId>hapi-fhir</artifactId>
  </parent>
</project>`;

    expect(detectPomImageIdentity(pom)).toBeUndefined();
  });

  it('returns nothing for a HAPI parent whose version has no numeric base', () => {
    const pom = `<project>
  <parent>
    <groupId>ca.uhn.hapi.fhir</groupId>
    <artifactId>hapi-fhir</artifactId>
    <version>LATEST</version>
  </parent>
</project>`;

    expect(detectPomImageIdentity(pom)).toBeUndefined();
  });

  it('resolves a revision written as a property reference', () => {
    const pom = `<project>
  <parent>
    <groupId>ca.uhn.hapi.fhir</groupId>
    <artifactId>hapi-fhir</artifactId>
    <version>8.4.0</version>
  </parent>
  <properties>
    <starter.rev>3</starter.rev>
    <hapi.fhir.jpa.server.starter.revision>\${starter.rev}</hapi.fhir.jpa.server.starter.revision>
  </properties>
</project>`;

    expect(detectPomImageIdentity(pom)).toEqual({ base: '8.4.0', revision: '3' });
  });

  it('flags a declared revision whose value cannot be read as an unknown image', () => {
    const pom = `<project>
  <parent>
    <groupId>ca.uhn.hapi.fhir</groupId>
    <artifactId>hapi-fhir</artifactId>
    <version>8.4.0</version>
  </parent>
  <properties>
    <hapi.fhir.jpa.server.starter.revision>\${missing.property}</hapi.fhir.jpa.server.starter.revision>
  </properties>
</project>`;

    expect(detectPomImageIdentity(pom)).toEqual({
      base: '8.4.0',
      revisionUnknown: true,
    });
  });
});

describe('detectHapiReleaseCandidates', () => {
  it('returns nothing for empty pom content', () => {
    expect(detectHapiReleaseCandidates('')).toEqual([]);
  });

  it('returns nothing for XML with no project element', () => {
    expect(
      detectHapiReleaseCandidates('<settings><hapi-fhir/></settings>'),
    ).toEqual([]);
  });

  it('pins the exact release when the pom names base and revision', () => {
    expect(detectHapiReleaseCandidates(hapiPom('8.4.0', '2'))).toEqual([
      '8.4.0-2',
    ]);
  });

  it('returns nothing for a base and revision outside the curated set', () => {
    expect(detectHapiReleaseCandidates(hapiPom('8.4.0', '9'))).toEqual([]);
  });

  it('returns nothing when the declared revision cannot be read', () => {
    const pom = hapiPom('8.4.0', '${missing}');

    expect(detectHapiReleaseCandidates(pom)).toEqual([]);
  });

  it('scans the whole pom for HAPI versions when it names no parent', () => {
    const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>8.8.0</version>
    </dependency>
  </dependencies>
</project>`;

    expect(detectHapiReleaseCandidates(pom)).toEqual(['8.8.0-1']);
  });

  it('stays ambiguous when a parentless pom names two different HAPI bases', () => {
    const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>8.8.0</version>
    </dependency>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-structures-r4</artifactId>
      <version>8.4.0</version>
    </dependency>
  </dependencies>
</project>`;

    expect(detectHapiReleaseCandidates(pom)).toEqual([]);
  });

  it('resolves a HAPI dependency version written as a property reference', () => {
    const pom = `<project>
  <properties>
    <hapi.version>8.8.0</hapi.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>\${hapi.version}</version>
    </dependency>
  </dependencies>
</project>`;

    expect(detectHapiReleaseCandidates(pom)).toEqual(['8.8.0-1']);
  });

  it('stays ambiguous when a HAPI dependency version is managed elsewhere', () => {
    // The unreadable version could disagree with the readable one, so the
    // readable 8.8.0 must not be reported as a definitive match.
    const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>8.8.0</version>
    </dependency>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-structures-r4</artifactId>
    </dependency>
  </dependencies>
</project>`;

    expect(detectHapiReleaseCandidates(pom)).toEqual([]);
  });

  it('ignores exclusions, which name coordinates without versions', () => {
    const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>8.8.0</version>
      <exclusions>
        <exclusion>
          <groupId>ca.uhn.hapi.fhir</groupId>
          <artifactId>hapi-fhir-caching-caffeine</artifactId>
        </exclusion>
      </exclusions>
    </dependency>
  </dependencies>
</project>`;

    // Without the exclusions skip, the versionless exclusion would make this ambiguous.
    expect(detectHapiReleaseCandidates(pom)).toEqual(['8.8.0-1']);
  });

  it('ignores versions of non-HAPI coordinates when scanning a parentless pom', () => {
    // Without the groupId filter the unrelated 42.7.4 would count as a second
    // base and leave the release ambiguous.
    const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>ca.uhn.hapi.fhir</groupId>
      <artifactId>hapi-fhir-base</artifactId>
      <version>8.8.0</version>
    </dependency>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <version>42.7.4</version>
    </dependency>
  </dependencies>
</project>`;

    expect(detectHapiReleaseCandidates(pom)).toEqual(['8.8.0-1']);
  });
});

describe('detectFhirVersionFromYaml', () => {
  it('returns nothing for empty config', () => {
    expect(detectFhirVersionFromYaml('')).toBeUndefined();
  });

  it('reads the version from nested keys', () => {
    expect(
      detectFhirVersionFromYaml('hapi:\n  fhir:\n    fhir_version: STU3\n'),
    ).toBe(FhirVersion.STU3);
  });

  it('reads the version from a flat dotted key', () => {
    expect(detectFhirVersionFromYaml('hapi.fhir.fhir_version: R4B')).toBe(
      FhirVersion.R4B,
    );
  });

  it('accepts a lowercase version', () => {
    expect(
      detectFhirVersionFromYaml('hapi:\n  fhir:\n    fhir_version: r5\n'),
    ).toBe(FhirVersion.R5);
  });

  it('returns nothing for a version outside the supported set', () => {
    expect(
      detectFhirVersionFromYaml('hapi:\n  fhir:\n    fhir_version: DSTU2\n'),
    ).toBeUndefined();
  });

  it('returns nothing when the key is absent', () => {
    expect(detectFhirVersionFromYaml('server:\n  port: 8080\n')).toBeUndefined();
  });

  it('returns nothing when the key holds a non-string value', () => {
    expect(
      detectFhirVersionFromYaml('hapi:\n  fhir:\n    fhir_version:\n      - R4\n'),
    ).toBeUndefined();
  });
});

describe('detectPackageBase', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('returns nothing when there is no Java source root', () => {
    expect(detectPackageBase(tree, 'server')).toBeUndefined();
  });

  it('treats an empty directory argument as the workspace root', () => {
    tree.write('src/main/java/org/acme/fhir/Custom.java', 'package org.acme.fhir;');

    expect(detectPackageBase(tree, '')).toBe('org.acme.fhir');
  });

  it('returns the common prefix of several custom packages', () => {
    tree.write('server/src/main/java/org/acme/fhir/A.java', 'package org.acme.fhir;');
    tree.write(
      'server/src/main/java/org/acme/provider/B.java',
      'package org.acme.provider;',
    );

    expect(detectPackageBase(tree, 'server')).toBe('org.acme');
  });

  it('returns nothing when custom packages share less than two segments', () => {
    tree.write('server/src/main/java/org/acme/A.java', 'package org.acme;');
    tree.write('server/src/main/java/com/other/B.java', 'package com.other;');

    expect(detectPackageBase(tree, 'server')).toBeUndefined();
  });

  it('returns nothing when only the HAPI starter package is present', () => {
    tree.write(
      'server/src/main/java/ca/uhn/fhir/jpa/starter/Application.java',
      'package ca.uhn.fhir.jpa.starter;',
    );

    expect(detectPackageBase(tree, 'server')).toBeUndefined();
  });

  it('ignores directories that hold no Java sources', () => {
    tree.write('server/src/main/java/org/acme/fhir/A.java', 'package org.acme.fhir;');
    // A resources-only directory under the Java root must not count as a package.
    tree.write('server/src/main/java/org/acme/notes/README.md', 'notes');

    expect(detectPackageBase(tree, 'server')).toBe('org.acme.fhir');
  });

  it('counts a package that holds Java sources beside other files', () => {
    tree.write('server/src/main/java/org/acme/fhir/A.java', 'package org.acme.fhir;');
    tree.write('server/src/main/java/org/acme/fhir/package.html', '<html></html>');

    expect(detectPackageBase(tree, 'server')).toBe('org.acme.fhir');
  });
});
