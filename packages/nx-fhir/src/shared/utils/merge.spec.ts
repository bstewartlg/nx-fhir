import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { Tree } from '@nx/devkit';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import * as prettier from 'prettier';
import {
  discardVerifiedWhitespaceOnlyEdits,
  discardWhitespaceOnlyEdits,
  isFormattingOnlyDifference,
  migrateWithThreeWayMerge,
} from './merge';

const projectRoot = 'server';

/** A slice of the HAPI starter application.yaml, indented the way upstream ships it */
const baseYaml = [
  'spring:',
  '    datasource:',
  '        url: jdbc:h2:mem:test_mem',
  '        username: sa',
  'hapi:',
  '    fhir:',
  '        fhir_version: R4',
  '',
].join('\n');

describe('isFormattingOnlyDifference', () => {
  it('reports a prettier reformat of the base as formatting only', async () => {
    const reformatted = await prettier.format(baseYaml, {
      parser: 'yaml',
      tabWidth: 2,
      singleQuote: true,
    });

    expect(reformatted).not.toBe(baseYaml);
    expect(
      await isFormattingOnlyDifference(
        baseYaml,
        reformatted,
        'application.yaml',
      ),
    ).toBe(true);
  });

  it('reports a value change as a real difference', async () => {
    const edited = baseYaml.replace('test_mem', 'prod_mem');

    expect(
      await isFormattingOnlyDifference(baseYaml, edited, 'application.yaml'),
    ).toBe(false);
  });

  it('reports false for file types prettier cannot parse', async () => {
    expect(
      await isFormattingOnlyDifference(
        'class A {}',
        'class  A  {}',
        'src/main/java/A.java',
      ),
    ).toBe(false);
    expect(await isFormattingOnlyDifference('<a/>', '<a />', 'pom.xml')).toBe(
      false,
    );
  });

  it('reports false when the content cannot be formatted', async () => {
    expect(
      await isFormattingOnlyDifference(
        '{ not: [json',
        '{ not: [json ',
        'a.json',
      ),
    ).toBe(false);
  });
});

describe('isFormattingOnlyDifference across prettier module shapes', () => {
  /** Content that only a working prettier can recognise as a pure reformat. */
  async function reformattedYaml() {
    return prettier.format(baseYaml, {
      parser: 'yaml',
      tabWidth: 2,
      singleQuote: true,
    });
  }

  afterEach(() => {
    vi.doUnmock('prettier');
    vi.resetModules();
  });

  it('reads the API from the default export the way prettier v2 exposes it', async () => {
    vi.resetModules();
    // A v2 module has no named getFileInfo; the API hangs off `default`.
    vi.doMock('prettier', () => ({
      getFileInfo: undefined,
      default: { getFileInfo: prettier.getFileInfo, format: prettier.format },
    }));

    const { isFormattingOnlyDifference: subject } = await import('./merge');

    expect(
      await subject(baseYaml, await reformattedYaml(), 'application.yaml'),
    ).toBe(true);
  });

  it('keeps a reformat as a real user change when prettier is unavailable', async () => {
    vi.resetModules();
    vi.doMock('prettier', () => ({ getFileInfo: undefined, default: undefined }));

    const { isFormattingOnlyDifference: subject, migrateWithThreeWayMerge: migrate } =
      await import('./merge');

    expect(
      await subject(baseYaml, await reformattedYaml(), 'application.yaml'),
    ).toBe(false);

    // A requoting is a reformat that collapsing whitespace cannot recognise,
    // so only prettier can tell it apart from an edit. With prettier the
    // upstream file replaces it verbatim; without prettier it counts as a user
    // change and the upstream edit has to be merged into it.
    const oldDir = mkdtempSync(join(tmpdir(), 'nx-fhir-merge-noprettier-old-'));
    const newDir = mkdtempSync(join(tmpdir(), 'nx-fhir-merge-noprettier-new-'));
    try {
      const oldTs = 'export const server = "http://localhost:8080";\n';
      const newTs = 'export const server = "http://localhost:9090";\n';
      const requoted = "export const server = 'http://localhost:8080';\n";
      writeFileSync(join(oldDir, 'config.ts'), oldTs);
      writeFileSync(join(newDir, 'config.ts'), newTs);

      const tree = createTreeWithEmptyWorkspace();
      tree.write(`${projectRoot}/config.ts`, requoted);

      const summary = await migrate(
        tree,
        projectRoot,
        oldDir,
        newDir,
        '1.0.0',
        '2.0.0',
      );

      expect(tree.read(`${projectRoot}/config.ts`, 'utf-8')).not.toBe(newTs);
      expect(summary.conflicts).toBe(1);
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });
});

describe('discardWhitespaceOnlyEdits', () => {
  it('reverts realigned trailing comments to the base text', () => {
    const base = 'a: 1        # note\nb: 2        # other\n';
    const current = 'a: 1 # note\nb: 2 # other\n';

    expect(discardWhitespaceOnlyEdits(base, current)).toBe(base);
  });

  it('reverts re-indented lines to the base text', () => {
    const base = '#  elasticsearch:\n#    uris: http://localhost:9200\n';
    const current = '  #  elasticsearch:\n  #    uris: http://localhost:9200\n';

    expect(discardWhitespaceOnlyEdits(base, current)).toBe(base);
  });

  it('keeps a value change and reverts the reformatting around it', () => {
    const base = 'server:\n  port: 8080\nhapi:\n  fhir:        # note\n';
    const current = 'server:\n  port: 8383\nhapi:\n  fhir: # note\n';

    expect(discardWhitespaceOnlyEdits(base, current)).toBe(
      'server:\n  port: 8383\nhapi:\n  fhir:        # note\n'
    );
  });

  it('keeps added and removed lines', () => {
    const base = 'a: 1\nb: 2\n';

    expect(discardWhitespaceOnlyEdits(base, 'a: 1\nb: 2\nc: 3\n')).toBe(
      'a: 1\nb: 2\nc: 3\n'
    );
    expect(discardWhitespaceOnlyEdits(base, 'a: 1\n')).toBe('a: 1\n');
  });

  it('treats a line ending change as a real change', () => {
    const base = 'a: 1\nb: 2\n';
    const current = 'a: 1\r\nb: 2\r\n';

    expect(discardWhitespaceOnlyEdits(base, current)).toBe(current);
  });
});

describe('discardVerifiedWhitespaceOnlyEdits', () => {
  it('heals YAML comment realignment because the documents parse the same', async () => {
    const base = 'a: 1        # note\nb: 2        # other\n';
    const current = 'a: 1 # note\nb: 2 # other\n';

    await expect(
      discardVerifiedWhitespaceOnlyEdits(base, current, 'application.yaml')
    ).resolves.toBe(base);
  });

  it('keeps a YAML indentation edit that changes nesting', async () => {
    const base = 'a:\n  b: 1\nc: 2\n';
    // Indenting c moves it under a, so the whitespace is the edit.
    const current = 'a:\n  b: 1\n  c: 2\n';

    await expect(
      discardVerifiedWhitespaceOnlyEdits(base, current, 'application.yaml')
    ).resolves.toBe(current);
  });

  it('keeps a spacing edit inside a quoted YAML scalar', async () => {
    const base = 'message: "a  b"\n';
    const current = 'message: "a b"\n';

    await expect(
      discardVerifiedWhitespaceOnlyEdits(base, current, 'application.yaml')
    ).resolves.toBe(current);
  });

  it('heals re-indentation in a TypeScript file via the prettier probe', async () => {
    const base = 'function f() {\nreturn 1;\n}\n';
    const current = 'function f() {\n  return 1;\n}\n';

    await expect(
      discardVerifiedWhitespaceOnlyEdits(base, current, 'src/f.ts')
    ).resolves.toBe(base);
  });

  it('keeps a spacing edit inside a TypeScript string literal', async () => {
    const base = "const s = 'a  b';\n";
    const current = "const s = 'a b';\n";

    await expect(
      discardVerifiedWhitespaceOnlyEdits(base, current, 'src/s.ts')
    ).resolves.toBe(current);
  });

  it('keeps whitespace edits in files no parser can verify', async () => {
    const base = 'SPRING_PROFILES=a  b\n';
    const current = 'SPRING_PROFILES=a b\n';

    await expect(
      discardVerifiedWhitespaceOnlyEdits(base, current, 'run.sh')
    ).resolves.toBe(current);
  });
});

describe('migrateWithThreeWayMerge', () => {
  let tree: Tree;
  let oldDir: string;
  let newDir: string;

  const writeVersionFile = (dir: string, path: string, content: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    oldDir = mkdtempSync(join(tmpdir(), 'nx-fhir-merge-old-'));
    newDir = mkdtempSync(join(tmpdir(), 'nx-fhir-merge-new-'));
  });

  afterEach(() => {
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it('takes the incoming content when the project file only differs by formatting', async () => {
    const newYaml = baseYaml.replace('fhir_version: R4', 'fhir_version: R5');
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', newYaml);

    // What a generator that ran prettier over the vendored file left behind
    const reformatted = await prettier.format(baseYaml, {
      parser: 'yaml',
      tabWidth: 2,
      singleQuote: true,
    });
    tree.write(`${projectRoot}/application.yaml`, reformatted);

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.conflicts).toBe(0);
    expect(tree.read(`${projectRoot}/application.yaml`, 'utf-8')).toBe(newYaml);
  });

  it('restores the upstream bytes even when the new version did not change the file', async () => {
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', baseYaml);

    const reformatted = await prettier.format(baseYaml, {
      parser: 'yaml',
      tabWidth: 2,
      singleQuote: true,
    });
    tree.write(`${projectRoot}/application.yaml`, reformatted);

    await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(tree.read(`${projectRoot}/application.yaml`, 'utf-8')).toBe(
      baseYaml,
    );
  });

  it('writes upstream changes in the working copy line ending style', async () => {
    const newYaml = baseYaml.replace('fhir_version: R4', 'fhir_version: R5');
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', newYaml);

    tree.write(
      `${projectRoot}/application.yaml`,
      baseYaml.replace(/\n/g, '\r\n'),
    );

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.conflicts).toBe(0);
    expect(tree.read(`${projectRoot}/application.yaml`, 'utf-8')).toBe(
      newYaml.replace(/\n/g, '\r\n'),
    );
  });

  it('leaves a CRLF working copy untouched when upstream did not change the file', async () => {
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', baseYaml);

    const crlf = baseYaml.replace(/\n/g, '\r\n');
    tree.write(`${projectRoot}/application.yaml`, crlf);

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.conflicts).toBe(0);
    expect(tree.read(`${projectRoot}/application.yaml`, 'utf-8')).toBe(crlf);
  });

  it('does not convert every line ending when only one line uses CRLF', async () => {
    const newYaml = baseYaml.replace('fhir_version: R4', 'fhir_version: R5');
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', newYaml);

    // A single CRLF line in an otherwise LF file must not turn the whole
    // file into CRLF on write.
    tree.write(
      `${projectRoot}/application.yaml`,
      baseYaml.replace('\n', '\r\n'),
    );

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.conflicts).toBe(0);
    expect(tree.read(`${projectRoot}/application.yaml`, 'utf-8')).toBe(newYaml);
  });

  it('updates an unmodified binary file byte for byte', async () => {
    const oldBytes = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0a, 0x01]);
    const newBytes = Buffer.from([0x00, 0x0d, 0x0a, 0xfe, 0x0a, 0x02]);
    writeFileSync(join(oldDir, 'keystore.p12'), oldBytes);
    writeFileSync(join(newDir, 'keystore.p12'), newBytes);
    tree.write(`${projectRoot}/keystore.p12`, oldBytes);

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.conflicts).toBe(0);
    expect(tree.read(`${projectRoot}/keystore.p12`)).toEqual(newBytes);
  });

  it('keeps a locally modified binary file when both sides changed', async () => {
    const oldBytes = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0a, 0x01]);
    const newBytes = Buffer.from([0x00, 0x0d, 0x0a, 0xfe, 0x0a, 0x02]);
    const localBytes = Buffer.from([0x00, 0x0d, 0x0a, 0xfd, 0x0a, 0x03]);
    writeFileSync(join(oldDir, 'keystore.p12'), oldBytes);
    writeFileSync(join(newDir, 'keystore.p12'), newBytes);
    tree.write(`${projectRoot}/keystore.p12`, localBytes);

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.conflicts).toBe(0);
    expect(tree.read(`${projectRoot}/keystore.p12`)).toEqual(localBytes);
  });

  it('updates a NUL-free binary file byte for byte', async () => {
    // 0xFE never appears in valid UTF-8, so these bytes are binary without
    // containing a NUL.
    const oldBytes = Buffer.from([0xfe, 0x02]);
    const newBytes = Buffer.from([0xfd, 0x03]);
    writeFileSync(join(oldDir, 'favicon.ico'), oldBytes);
    writeFileSync(join(newDir, 'favicon.ico'), newBytes);
    tree.write(`${projectRoot}/favicon.ico`, oldBytes);

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.conflicts).toBe(0);
    expect(tree.read(`${projectRoot}/favicon.ico`)).toEqual(newBytes);
  });

  it('keeps a locally modified binary file that upstream deleted', async () => {
    // Both byte pairs decode to the same UTF-8 text, so only a byte
    // comparison can tell them apart.
    const oldBytes = Buffer.from([0x00, 0xff]);
    const localBytes = Buffer.from([0x00, 0xfe]);
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', baseYaml);
    writeFileSync(join(oldDir, 'keystore.p12'), oldBytes);
    tree.write(`${projectRoot}/application.yaml`, baseYaml);
    tree.write(`${projectRoot}/keystore.p12`, localBytes);

    await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(tree.read(`${projectRoot}/keystore.p12`)).toEqual(localBytes);
  });

  it('removes an unmodified binary file that upstream deleted', async () => {
    const bytes = Buffer.from([0x00, 0xff]);
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', baseYaml);
    writeFileSync(join(oldDir, 'keystore.p12'), bytes);
    tree.write(`${projectRoot}/application.yaml`, baseYaml);
    tree.write(`${projectRoot}/keystore.p12`, bytes);

    await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(tree.exists(`${projectRoot}/keystore.p12`)).toBe(false);
  });

  it('leaves an unchanged binary file untouched', async () => {
    const bytes = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0a, 0x01]);
    writeFileSync(join(oldDir, 'keystore.p12'), bytes);
    writeFileSync(join(newDir, 'keystore.p12'), bytes);
    tree.write(`${projectRoot}/keystore.p12`, bytes);

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.unchanged).toBe(1);
    expect(tree.read(`${projectRoot}/keystore.p12`)).toEqual(bytes);
  });

  it('removes an upstream-deleted file whose only local difference is line endings', async () => {
    writeVersionFile(oldDir, 'removed.yaml', baseYaml);
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', baseYaml);

    tree.write(
      `${projectRoot}/removed.yaml`,
      baseYaml.replace(/\n/g, '\r\n'),
    );
    tree.write(`${projectRoot}/application.yaml`, baseYaml);

    await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(tree.exists(`${projectRoot}/removed.yaml`)).toBe(false);
  });

  it('keeps a real user edit and applies the upstream change alongside it', async () => {
    const newYaml = baseYaml.replace('fhir_version: R4', 'fhir_version: R5');
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(newDir, 'application.yaml', newYaml);

    tree.write(
      `${projectRoot}/application.yaml`,
      baseYaml.replace('username: sa', 'username: custom'),
    );

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    const merged = tree.read(`${projectRoot}/application.yaml`, 'utf-8');
    expect(summary.conflicts).toBe(0);
    expect(merged).toContain('username: custom');
    expect(merged).toContain('fhir_version: R5');
  });

  it('still conflicts when a real user edit overlaps an upstream edit', async () => {
    writeVersionFile(oldDir, 'application.yaml', baseYaml);
    writeVersionFile(
      newDir,
      'application.yaml',
      baseYaml.replace('username: sa', 'username: upstream'),
    );

    tree.write(
      `${projectRoot}/application.yaml`,
      baseYaml.replace('username: sa', 'username: mine'),
    );

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(summary.conflicts).toBe(1);
    expect(tree.read(`${projectRoot}/application.yaml`, 'utf-8')).toContain(
      '<<<<<<<',
    );
  });

  it('merges a user edit that sits inside a region both sides reformatted', async () => {
    // The shape the e2e hits: the user changed one value with a serializer
    // that realigned every trailing comment in the file, and the new release
    // edited a different value in a block the serializer also touched.
    const base = [
      'server:',
      '  port: 8080          # listen port',
      'hapi:',
      '  fhir:',
      '    terminology:',
      '      preexpansion: REQUIRE            # a | b',
      '      expansion: NAIVE                 # c | d',
      '',
    ].join('\n');
    const newContent = base.replace(
      'preexpansion: REQUIRE',
      'preexpansion: USE_IF_PRESENT'
    );
    const current = [
      'server:',
      '  port: 8383 # listen port',
      'hapi:',
      '  fhir:',
      '    terminology:',
      '      preexpansion: REQUIRE # a | b',
      '      expansion: NAIVE # c | d',
      '',
    ].join('\n');

    writeVersionFile(oldDir, 'application.yaml', base);
    writeVersionFile(newDir, 'application.yaml', newContent);
    tree.write(`${projectRoot}/application.yaml`, current);

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0'
    );

    const merged = tree.read(`${projectRoot}/application.yaml`, 'utf-8');
    expect(summary.conflicts).toBe(0);
    expect(merged).toContain('preexpansion: USE_IF_PRESENT');
    expect(merged).toContain('port: 8383');
  });

  it('merges files prettier cannot parse without consulting the probe', async () => {
    const basePom = [
      '<project>',
      '  <version>1</version>',
      '  <a/>',
      '  <b/>',
      '  <c/>',
      '  <d/>',
      '  <dependencies/>',
      '</project>',
      '',
    ].join('\n');
    writeVersionFile(oldDir, 'pom.xml', basePom);
    writeVersionFile(
      newDir,
      'pom.xml',
      basePom.replace('<version>1</version>', '<version>2</version>'),
    );
    tree.write(
      `${projectRoot}/pom.xml`,
      basePom.replace(
        '<dependencies/>',
        '<dependencies><mine/></dependencies>',
      ),
    );

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    const merged = tree.read(`${projectRoot}/pom.xml`, 'utf-8');
    expect(summary.conflicts).toBe(0);
    expect(merged).toContain('<version>2</version>');
    expect(merged).toContain('<dependencies><mine/></dependencies>');
  });

  it('keeps a user-modified file that upstream deleted', async () => {
    writeVersionFile(oldDir, 'src/custom.properties', 'key=upstream\n');
    tree.write(`${projectRoot}/src/custom.properties`, 'key=mine\n');

    const summary = await migrateWithThreeWayMerge(
      tree,
      projectRoot,
      oldDir,
      newDir,
      '1.0.0',
      '2.0.0',
    );

    expect(tree.read(`${projectRoot}/src/custom.properties`, 'utf-8')).toBe(
      'key=mine\n',
    );
    expect(summary.removed).toBe(0);
    expect(summary.unchanged).toBeGreaterThan(0);
  });
});

describe('discardVerifiedWhitespaceOnlyEdits with unparseable YAML', () => {
  it('keeps the user bytes when the document cannot be parsed', async () => {
    const base = 'key: value\n\tmixed: [unclosed\n';
    const edited = 'key:  value\n\tmixed: [unclosed\n';

    expect(
      await discardVerifiedWhitespaceOnlyEdits(base, edited, 'broken.yaml'),
    ).toBe(edited);
  });
});
