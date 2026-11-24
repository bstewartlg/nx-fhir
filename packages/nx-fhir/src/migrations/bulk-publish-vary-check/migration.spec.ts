import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { addProjectConfiguration, logger, Tree } from '@nx/devkit';

import bulkPublishVaryCheck from './migration';
import { FhirVersion, ServerProjectConfiguration } from '../../shared/models';

const BULK_PUBLISH = { 'bulk-publish': { version: 1, options: {} } };

// The three Vary assertions in the layout of the 0.3.2 feature template.
const RELEASED = [
  'package com.example.publish;',
  '',
  'import java.util.ArrayList;',
  'import java.util.List;',
  '',
  'class BulkPublishIT {',
  '\tvoid refused() {',
  '\t\tassertEquals(',
  '\t\t\t\t"Accept-Encoding, Accept",',
  '\t\t\t\trejected.headers().firstValue("Vary").orElse(null),',
  '\t\t\t\t"a refused Accept still selects on both headers, so the 406 carries the same Vary");',
  '\t}',
  '',
  '\tvoid plain() {',
  '\t\tassertEquals(',
  '\t\t\t\t"Accept-Encoding, Accept",',
  '\t\t\t\tresponse.headers().firstValue("Vary").orElse(null),',
  '\t\t\t\t"file responses select on both Accept-Encoding and Accept, so Vary names both");',
  '\t}',
  '',
  '\tvoid gzip() {',
  '\t\tassertEquals(',
  '\t\t\t\t"Accept-Encoding, Accept",',
  '\t\t\t\tresponse.headers().firstValue("Vary").orElse(null),',
  '\t\t\t\t"file responses select on both Accept-Encoding and Accept, so Vary names both");',
  '\t}',
  '}',
  '',
];

const REPAIRED = [
  'package com.example.publish;',
  '',
  'import java.util.ArrayList;',
  'import java.util.Arrays;',
  'import java.util.List;',
  '',
  'class BulkPublishIT {',
  '\tvoid refused() {',
  '\t\tassertVaryNamesAcceptEncodingAndAccept(',
  '\t\t\t\trejected, "a refused Accept still selects on both headers, so the 406 carries the same Vary");',
  '\t}',
  '',
  '\tvoid plain() {',
  '\t\tassertVaryNamesAcceptEncodingAndAccept(',
  '\t\t\t\tresponse, "file responses select on both Accept-Encoding and Accept, so Vary names both");',
  '\t}',
  '',
  '\tvoid gzip() {',
  '\t\tassertVaryNamesAcceptEncodingAndAccept(',
  '\t\t\t\tresponse, "file responses select on both Accept-Encoding and Accept, so Vary names both");',
  '\t}',
  '',
  '\t/** A CORS mapping can add its own Vary header or name, so the check reads every Vary value. */',
  '\tprivate static void assertVaryNamesAcceptEncodingAndAccept(HttpResponse<?> response, String message) {',
  '\t\tList<String> names = response.headers().allValues("Vary").stream()',
  '\t\t\t\t.flatMap(value -> Arrays.stream(value.split(",")))',
  '\t\t\t\t.map(String::trim)',
  '\t\t\t\t.toList();',
  '\t\tassertTrue(names.containsAll(List.of("Accept-Encoding", "Accept")), message);',
  '\t}',
  '}',
  '',
];

function addServer(tree: Tree, root: string, features?: typeof BULK_PUBLISH): string {
  addProjectConfiguration(tree, root, {
    root,
    packageBase: 'com.example',
    fhirVersion: FhirVersion.R4,
    features,
  } as ServerProjectConfiguration);
  return `${root}/src/test/java/com/example/publish/BulkPublishIT.java`;
}

describe('bulk-publish-vary-check migration', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('repairs the 0.3.2 assertions in a %s file, and a second run changes nothing', (_name, eol) => {
    const file = addServer(tree, 'server', BULK_PUBLISH);
    tree.write(file, RELEASED.join(eol));

    bulkPublishVaryCheck(tree);
    expect(tree.read(file, 'utf-8')).toBe(REPAIRED.join(eol));

    bulkPublishVaryCheck(tree);
    expect(tree.read(file, 'utf-8')).toBe(REPAIRED.join(eol));
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('leaves a file with edited assertions and a server without the feature unchanged', () => {
    const edited = RELEASED.join('\n').replace(
      /assertEquals\(\n\t+"Accept-Encoding, Accept",\n\t+/g,
      'assertEquals("Accept-Encoding, Accept", ',
    );
    const editedFile = addServer(tree, 'edited', BULK_PUBLISH);
    tree.write(editedFile, edited);
    const withoutFeatureFile = addServer(tree, 'without-feature');
    tree.write(withoutFeatureFile, RELEASED.join('\n'));
    const absentFile = addServer(tree, 'absent', BULK_PUBLISH);

    bulkPublishVaryCheck(tree);

    expect(tree.read(editedFile, 'utf-8')).toBe(edited);
    expect(tree.read(withoutFeatureFile, 'utf-8')).toBe(RELEASED.join('\n'));
    expect(tree.exists(absentFile)).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
